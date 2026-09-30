// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title BlarcRobinhoodFeeRouter
/// @notice One user-signed swap on Robinhood Chain (chain id 4663).
///         Takes 1% (100 bps) of the sell amount and swaps the other 99%
///         through the chain Uniswap SwapRouter02. Bought tokens go to the user.
/// @dev Not deployed. No admin, no upgrade, no fee change, no arbitrary pull.
///      Fee recipient is fixed to the BLARC Robinhood wallet
///      0x9A47cC17077ea358052FF6233d8aBEe0041E35ed.
///      Deployer passes SwapRouter02 (verified 0xCaf681a66D020601342297493863E78C959E5cb2).
///      WETH is read from that router's WETH9() and stored immutable.
interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

interface ISwapRouter02 {
    function WETH9() external view returns (address);

    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

contract BlarcRobinhoodFeeRouter {
    uint256 public constant FEE_BPS = 100;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    /// @dev The 0x / bot native-asset sentinel. address(0) is accepted too.
    address public constant NATIVE_SENTINEL = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    /// @dev Robinhood fee wallet. Constructor reverts if a different recipient is passed.
    address public constant REQUIRED_FEE_RECIPIENT = 0x9A47cC17077ea358052FF6233d8aBEe0041E35ed;

    address public immutable swapRouter;
    address public immutable feeRecipient;
    address public immutable weth;

    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _status;

    error ZeroAddress();
    error WrongFeeRecipient();
    error Expired();
    error BadValue();
    error SameToken();
    error FeeZero();
    error FeeTransferFailed();
    error TransferFailed();
    error ApproveFailed();
    error Slippage();
    error Reentrancy();
    error EthSendFailed();

    event Swapped(
        address indexed sender,
        address indexed tokenIn,
        address tokenOut,
        uint24 poolFee,
        uint256 amountIn,
        uint256 feeAmount,
        uint256 amountOut
    );

    constructor(address swapRouter_, address feeRecipient_) {
        if (swapRouter_ == address(0) || feeRecipient_ == address(0)) revert ZeroAddress();
        if (feeRecipient_ != REQUIRED_FEE_RECIPIENT) revert WrongFeeRecipient();
        address weth_ = ISwapRouter02(swapRouter_).WETH9();
        if (weth_ == address(0)) revert ZeroAddress();
        swapRouter = swapRouter_;
        feeRecipient = feeRecipient_;
        weth = weth_;
        _status = _NOT_ENTERED;
    }

    /// @dev Accepts ETH only from WETH.withdraw. There is no rescue function.
    receive() external payable {
        if (msg.sender != weth) revert EthSendFailed();
    }

    /// @notice Swap `amountIn` of tokenIn for tokenOut. The signer is the user.
    /// @param tokenIn Sell token. Native ETH is address(0) or the 0xeeee sentinel. Send amountIn as msg.value.
    /// @param tokenOut Buy token. Native ETH unwraps WETH to the user. WETH itself is the WETH ERC-20.
    /// @param poolFee Uniswap v3 fee tier of the pool (for example 100, 500, 3000, 10000).
    /// @param amountIn Full sell amount. 1% is the fee. 99% is swapped.
    /// @param amountOutMinimum Slippage floor on the bought amount. The swap reverts under it.
    /// @param deadline Unix time after which the swap reverts.
    function swapExactInputSingle(
        address tokenIn,
        address tokenOut,
        uint24 poolFee,
        uint256 amountIn,
        uint256 amountOutMinimum,
        uint256 deadline
    ) external payable nonReentrant returns (uint256 amountOut) {
        if (block.timestamp > deadline) revert Expired();
        if (amountIn == 0) revert FeeZero();
        if (_isNative(tokenIn) && msg.value != amountIn) revert BadValue();
        if (!_isNative(tokenIn) && msg.value != 0) revert BadValue();

        uint256 feeAmount = (amountIn * FEE_BPS) / BPS_DENOMINATOR;
        if (feeAmount == 0 || feeAmount >= amountIn) revert FeeZero();
        uint256 swapAmount = amountIn - feeAmount;

        bool nativeIn = _isNative(tokenIn);
        bool nativeOut = _isNative(tokenOut);
        address swapTokenIn = nativeIn ? weth : tokenIn;
        address swapTokenOut = nativeOut ? weth : tokenOut;
        if (swapTokenIn == swapTokenOut || tokenIn == tokenOut) revert SameToken();

        if (nativeIn) {
            _takeEthFee(feeAmount, swapAmount);
        } else {
            _takeTokenFee(tokenIn, feeAmount, swapAmount);
        }

        _setRouterAllowance(swapTokenIn, swapAmount);
        amountOut = _swap(swapTokenIn, swapTokenOut, poolFee, swapAmount, amountOutMinimum, nativeOut);
        _setRouterAllowance(swapTokenIn, 0);
        if (amountOut < amountOutMinimum) revert Slippage();

        emit Swapped(msg.sender, tokenIn, tokenOut, poolFee, amountIn, feeAmount, amountOut);
    }

    function _swap(
        address swapTokenIn,
        address swapTokenOut,
        uint24 poolFee,
        uint256 swapAmount,
        uint256 amountOutMinimum,
        bool nativeOut
    ) private returns (uint256 amountOut) {
        if (nativeOut) {
            uint256 wethBefore = IERC20(weth).balanceOf(address(this));
            uint256 quoted = ISwapRouter02(swapRouter).exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn: swapTokenIn,
                    tokenOut: swapTokenOut,
                    fee: poolFee,
                    recipient: address(this),
                    amountIn: swapAmount,
                    amountOutMinimum: amountOutMinimum,
                    sqrtPriceLimitX96: 0
                })
            );
            uint256 gained = IERC20(weth).balanceOf(address(this)) - wethBefore;
            if (quoted < amountOutMinimum || gained < amountOutMinimum) revert Slippage();
            uint256 ethBefore = address(this).balance;
            IWETH(weth).withdraw(gained);
            uint256 ethGained = address(this).balance - ethBefore;
            if (ethGained < amountOutMinimum) revert Slippage();
            _sendEth(msg.sender, ethGained);
            return ethGained;
        }

        uint256 beforeOut = IERC20(swapTokenOut).balanceOf(msg.sender);
        uint256 quotedOut = ISwapRouter02(swapRouter).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: swapTokenIn,
                tokenOut: swapTokenOut,
                fee: poolFee,
                recipient: msg.sender,
                amountIn: swapAmount,
                amountOutMinimum: amountOutMinimum,
                sqrtPriceLimitX96: 0
            })
        );
        uint256 gainedOut = IERC20(swapTokenOut).balanceOf(msg.sender) - beforeOut;
        if (quotedOut < amountOutMinimum || gainedOut < amountOutMinimum) revert Slippage();
        return gainedOut;
    }

    function _takeEthFee(uint256 feeAmount, uint256 swapAmount) private {
        (bool ok,) = feeRecipient.call{value: feeAmount}("");
        if (!ok) revert FeeTransferFailed();
        uint256 beforeBal = IERC20(weth).balanceOf(address(this));
        IWETH(weth).deposit{value: swapAmount}();
        if (IERC20(weth).balanceOf(address(this)) - beforeBal != swapAmount) revert TransferFailed();
    }

    function _takeTokenFee(address token, uint256 feeAmount, uint256 swapAmount) private {
        uint256 feeBefore = IERC20(token).balanceOf(feeRecipient);
        _safeTransferFrom(token, msg.sender, feeRecipient, feeAmount);
        if (IERC20(token).balanceOf(feeRecipient) - feeBefore < feeAmount) revert FeeTransferFailed();

        uint256 beforeBal = IERC20(token).balanceOf(address(this));
        _safeTransferFrom(token, msg.sender, address(this), swapAmount);
        if (IERC20(token).balanceOf(address(this)) - beforeBal < swapAmount) revert TransferFailed();
    }

    function _setRouterAllowance(address token, uint256 amount) private {
        uint256 current = IERC20(token).allowance(address(this), swapRouter);
        if (current == amount) return;
        if (current != 0) _forceApprove(token, 0);
        if (amount != 0) _forceApprove(token, amount);
    }

    function _forceApprove(address token, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.approve.selector, swapRouter, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert ApproveFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _sendEth(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert EthSendFailed();
    }

    function _isNative(address token) private pure returns (bool) {
        return token == address(0) || token == NATIVE_SENTINEL;
    }

    modifier nonReentrant() {
        if (_status == _ENTERED) revert Reentrancy();
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }
}
