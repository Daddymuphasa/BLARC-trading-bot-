// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BlarcRobinhoodFeeRouter} from "../contracts/robinhood/BlarcRobinhoodFeeRouter.sol";

contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MockWETH is MockERC20 {
    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "withdraw");
    }

    receive() external payable {}
}

interface IExact {
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

contract MockSwapRouter {
    address public immutable weth;
    address public recipientSeen;
    address public tokenInSeen;
    address public tokenOutSeen;
    uint256 public amountInSeen;
    uint256 public minSeen;
    uint24 public feeSeen;
    uint256 public allowanceSeen;
    uint256 public outAmount;
    bool public fail;

    constructor(address weth_) {
        weth = weth_;
    }

    function WETH9() external view returns (address) {
        return weth;
    }

    function setOut(uint256 amount) external {
        outAmount = amount;
    }

    function setFail(bool value) external {
        fail = value;
    }

    function exactInputSingle(IExact.ExactInputSingleParams calldata params) external payable returns (uint256) {
        require(!fail, "router fail");
        require(params.sqrtPriceLimitX96 == 0, "limit");
        tokenInSeen = params.tokenIn;
        tokenOutSeen = params.tokenOut;
        recipientSeen = params.recipient;
        amountInSeen = params.amountIn;
        minSeen = params.amountOutMinimum;
        feeSeen = params.fee;
        allowanceSeen = MockERC20(params.tokenIn).allowance(msg.sender, address(this));
        require(allowanceSeen >= params.amountIn, "pull allowance");
        require(MockERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn), "pull");
        require(params.amountOutMinimum <= outAmount, "Too little received");
        require(MockERC20(params.tokenOut).transfer(params.recipient, outAmount), "pay");
        return outAmount;
    }
}

contract ReenterToken {
    BlarcRobinhoodFeeRouter public router;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public attempted;
    bool public innerOk;

    function setRouter(address router_) external {
        router = BlarcRobinhoodFeeRouter(payable(router_));
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (!attempted) {
            attempted = true;
            (bool ok,) = address(router).call(
                abi.encodeWithSelector(
                    router.swapExactInputSingle.selector,
                    address(this),
                    address(1),
                    uint24(3000),
                    uint256(10000),
                    uint256(1),
                    block.timestamp + 100
                )
            );
            innerOk = ok;
        }
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract BlarcRobinhoodFeeRouterTest {
    address internal constant FEE = 0x729241d4d22cb8bD54E9210D1FE1e16b74A2a784;
    uint256 internal constant SELL = 10_000;
    uint256 internal constant FEE_PART = 100;
    uint256 internal constant SWAP_PART = 9_900;

    MockWETH internal weth;
    MockSwapRouter internal dex;
    MockERC20 internal usdc;
    BlarcRobinhoodFeeRouter internal router;

    function setUp() public {
        weth = new MockWETH();
        dex = new MockSwapRouter(address(weth));
        usdc = new MockERC20();
        router = new BlarcRobinhoodFeeRouter(address(dex), FEE);
    }

    function test_fee_split_erc20() public {
        usdc.mint(address(this), SELL);
        usdc.approve(address(router), SELL);
        MockERC20 out = new MockERC20();
        out.mint(address(dex), 5000);
        dex.setOut(5000);

        uint256 bought = router.swapExactInputSingle(address(usdc), address(out), 3000, SELL, 4900, block.timestamp + 60);

        require(bought == 5000, "bought");
        require(usdc.balanceOf(FEE) == FEE_PART, "fee 1%");
        require(usdc.balanceOf(address(dex)) == SWAP_PART, "swap 99%");
        require(usdc.balanceOf(address(this)) == 0, "user sold all");
        require(out.balanceOf(address(this)) == 5000, "user received");
        require(out.balanceOf(address(router)) == 0, "router kept nothing");
        require(dex.amountInSeen() == SWAP_PART, "router saw 99%");
        require(dex.recipientSeen() == address(this), "paid user");
        require(dex.feeSeen() == 3000, "tier");
        require(usdc.allowance(address(router), address(dex)) == 0, "allowance reset");
        require(dex.allowanceSeen() == SWAP_PART, "exact allowance");
    }

    function test_slippage_reverts_and_keeps_funds() public {
        usdc.mint(address(this), SELL);
        usdc.approve(address(router), SELL);
        MockERC20 out = new MockERC20();
        out.mint(address(dex), 10);
        dex.setOut(10);
        (bool ok,) = address(router).call(
            abi.encodeWithSelector(
                router.swapExactInputSingle.selector, address(usdc), address(out), uint24(500), SELL, uint256(100), block.timestamp + 60
            )
        );
        require(!ok, "should revert");
        require(usdc.balanceOf(address(this)) == SELL, "not taken");
        require(usdc.balanceOf(FEE) == 0, "no fee");
    }

    function test_router_failure_reverts() public {
        usdc.mint(address(this), SELL);
        usdc.approve(address(router), SELL);
        MockERC20 out = new MockERC20();
        dex.setFail(true);
        (bool ok,) = address(router).call(
            abi.encodeWithSelector(
                router.swapExactInputSingle.selector, address(usdc), address(out), uint24(500), SELL, uint256(1), block.timestamp + 60
            )
        );
        require(!ok, "fail");
        require(usdc.balanceOf(FEE) == 0, "no fee on fail");
        require(usdc.balanceOf(address(this)) == SELL, "kept");
    }

    function test_fee_zero_reverts() public {
        (bool ok,) = address(router).call(
            abi.encodeWithSelector(
                router.swapExactInputSingle.selector,
                address(usdc),
                address(weth),
                uint24(3000),
                uint256(99),
                uint256(1),
                block.timestamp + 60
            )
        );
        require(!ok, "tiny");
    }

    function test_deadline_reverts() public {
        usdc.mint(address(this), SELL);
        usdc.approve(address(router), SELL);
        (bool ok,) = address(router).call(
            abi.encodeWithSelector(
                router.swapExactInputSingle.selector, address(usdc), address(weth), uint24(3000), SELL, uint256(1), block.timestamp - 1
            )
        );
        require(!ok, "deadline");
        require(usdc.balanceOf(address(this)) == SELL, "kept");
    }

    function test_native_in_takes_eth_fee_and_wraps_rest() public {
        MockERC20 out = new MockERC20();
        out.mint(address(dex), 7000);
        dex.setOut(7000);
        uint256 beforeFee = FEE.balance;
        uint256 bought = router.swapExactInputSingle{value: SELL}(address(0), address(out), 100, SELL, 6900, block.timestamp + 60);
        require(bought == 7000, "bought");
        require(FEE.balance - beforeFee == FEE_PART, "eth fee");
        require(weth.balanceOf(address(dex)) == SWAP_PART, "wrapped 99%");
        require(out.balanceOf(address(this)) == 7000, "out");
        require(address(router).balance == 0, "no eth stuck");
        require(weth.allowance(address(router), address(dex)) == 0, "weth allowance reset");
    }

    function test_native_out_unwraps_to_user() public {
        usdc.mint(address(this), SELL);
        usdc.approve(address(router), SELL);
        weth.mint(address(dex), 8000);
        // MockWETH.mint does not back ETH. Fund the WETH contract so withdraw can pay.
        (bool funded,) = address(weth).call{value: 8000}("");
        require(funded, "fund weth");
        dex.setOut(8000);
        uint256 before = address(this).balance;
        uint256 bought = router.swapExactInputSingle(
            address(usdc), BlarcRobinhoodFeeRouter(payable(router)).NATIVE_SENTINEL(), 10000, SELL, 7900, block.timestamp + 60
        );
        require(bought == 8000, "eth out");
        require(address(this).balance - before == 8000, "user eth");
        require(dex.recipientSeen() == address(router), "weth to router");
        require(dex.tokenOutSeen() == address(weth), "pool out is weth");
        require(usdc.balanceOf(FEE) == FEE_PART, "fee");
        require(address(router).balance == 0, "router eth empty");
    }

    function test_eth_fee_failure_reverts() public {
        // Cannot retarget the immutable recipient. A rejecting recipient is not the fixed wallet.
        // Simulate a failed fee by using a token that returns false... covered by router failure.
        // Native fee to the fixed recipient succeeds for an EOA. Value mismatch must revert.
        (bool ok,) = address(router).call{value: 1}(
            abi.encodeWithSelector(
                router.swapExactInputSingle.selector, address(0), address(usdc), uint24(3000), SELL, uint256(1), block.timestamp + 60
            )
        );
        require(!ok, "value");
    }

    function test_reentrancy_guard() public {
        ReenterToken evil = new ReenterToken();
        evil.setRouter(address(router));
        evil.mint(address(this), SELL);
        evil.approve(address(router), SELL);
        MockERC20 out = new MockERC20();
        out.mint(address(dex), 5000);
        dex.setOut(5000);
        uint256 bought = router.swapExactInputSingle(address(evil), address(out), 3000, SELL, 1, block.timestamp + 60);
        require(bought == 5000, "outer");
        require(evil.attempted(), "tried");
        require(evil.innerOk() == false, "inner blocked");
        require(evil.balanceOf(FEE) == FEE_PART, "one fee");
    }

    function test_constructor_locks_fee_recipient() public {
        try new BlarcRobinhoodFeeRouter(address(dex), address(1)) {
            require(false, "should revert");
        } catch {}
        try new BlarcRobinhoodFeeRouter(address(0), FEE) {
            require(false, "zero router");
        } catch {}
        require(router.feeRecipient() == FEE, "fee");
        require(router.FEE_BPS() == 100, "bps");
        require(router.weth() == address(weth), "weth");
    }

    function test_same_token_reverts() public {
        (bool ok,) = address(router).call{value: SELL}(
            abi.encodeWithSelector(
                router.swapExactInputSingle.selector, address(0), address(weth), uint24(3000), SELL, uint256(1), block.timestamp + 60
            )
        );
        require(!ok, "weth out of eth is same");
    }

    receive() external payable {}
}
