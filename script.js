const header = document.querySelector(".site-header");
const root = document.documentElement;
const tabs = Array.from(document.querySelectorAll(".tab"));
const panels = Array.from(document.querySelectorAll(".product-panel"));
const accordionButtons = Array.from(document.querySelectorAll(".accordion button"));
const sentinel = document.querySelector(".blarc-sentinel");
const interactiveCards = Array.from(
  document.querySelectorAll(".hero-visual, .feature-grid article, .product-panel, .mock-phone, .price-card, .community-card, .security-grid article"),
);

const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const pointer = {
  x: window.innerWidth - 144,
  y: 138,
  targetX: window.innerWidth - 144,
  targetY: 138,
};

function setHeaderState() {
  header.dataset.elevated = window.scrollY > 10 ? "true" : "false";
}

function activateTab(tab) {
  const targetId = tab.getAttribute("aria-controls");

  tabs.forEach((item) => {
    const isCurrent = item === tab;
    item.classList.toggle("is-active", isCurrent);
    item.setAttribute("aria-selected", String(isCurrent));
  });

  panels.forEach((panel) => {
    const isCurrent = panel.id === targetId;
    panel.classList.toggle("is-active", isCurrent);
    panel.hidden = !isCurrent;
  });
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => activateTab(tab));
});

accordionButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const content = button.nextElementSibling;
    const isOpen = button.getAttribute("aria-expanded") === "true";
    button.setAttribute("aria-expanded", String(!isOpen));
    content.hidden = isOpen;
  });
});

function moveSentinel() {
  if (!sentinel || prefersReducedMotion || window.innerWidth < 621) {
    return;
  }

  pointer.x += (pointer.targetX - pointer.x) * 0.1;
  pointer.y += (pointer.targetY - pointer.y) * 0.1;

  const ry = Math.max(-16, Math.min(16, (pointer.targetX - pointer.x) * 0.12));
  const rx = Math.max(-12, Math.min(12, (pointer.y - pointer.targetY) * 0.09));

  root.style.setProperty("--sentinel-x", `${pointer.x}px`);
  root.style.setProperty("--sentinel-y", `${pointer.y}px`);
  root.style.setProperty("--sentinel-rx", `${rx}deg`);
  root.style.setProperty("--sentinel-ry", `${ry}deg`);

  window.requestAnimationFrame(moveSentinel);
}

function setCardTilt(event) {
  const card = event.currentTarget;
  const rect = card.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width - 0.5;
  const y = (event.clientY - rect.top) / rect.height - 0.5;
  card.style.transform = `perspective(900px) rotateX(${y * -4}deg) rotateY(${x * 5}deg) translateY(-4px)`;
}

function resetCardTilt(event) {
  event.currentTarget.style.transform = "";
}

if (!prefersReducedMotion) {
  window.addEventListener(
    "pointermove",
    (event) => {
      pointer.targetX = Math.min(window.innerWidth - 76, Math.max(76, event.clientX + 72));
      pointer.targetY = Math.min(window.innerHeight - 76, Math.max(76, event.clientY - 58));
    },
    { passive: true },
  );

  interactiveCards.forEach((card) => {
    card.addEventListener("pointermove", setCardTilt);
    card.addEventListener("pointerleave", resetCardTilt);
  });

  moveSentinel();
}

window.addEventListener("scroll", setHeaderState, { passive: true });
setHeaderState();
