const header = document.querySelector(".site-header");
const tabs = Array.from(document.querySelectorAll(".tab"));
const panels = Array.from(document.querySelectorAll(".product-panel"));
const accordionButtons = Array.from(document.querySelectorAll(".accordion button"));
const interactiveCards = Array.from(
  document.querySelectorAll(
    ".hero-visual, .feature-grid article, .product-panel, .mock-phone, .community-card, .security-grid article, .steps li",
  ),
);

const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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
    accordionButtons.forEach((item) => {
      if (item !== button) {
        item.setAttribute("aria-expanded", "false");
        item.nextElementSibling.hidden = true;
      }
    });
    button.setAttribute("aria-expanded", String(!isOpen));
    content.hidden = isOpen;
  });
});

function setCardTilt(event) {
  const card = event.currentTarget;
  const rect = card.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const tiltX = y / rect.height - 0.5;
  const tiltY = x / rect.width - 0.5;

  card.style.setProperty("--spot-x", `${x}px`);
  card.style.setProperty("--spot-y", `${y}px`);
  card.style.transform = `perspective(900px) rotateX(${tiltX * -4}deg) rotateY(${tiltY * 5}deg) translateY(-4px)`;
}

function resetCardTilt(event) {
  const card = event.currentTarget;
  card.style.transform = "";
}

if (!prefersReducedMotion) {
  interactiveCards.forEach((card) => {
    card.addEventListener("pointermove", setCardTilt);
    card.addEventListener("pointerleave", resetCardTilt);
  });
}

window.addEventListener("scroll", setHeaderState, { passive: true });
setHeaderState();

const revealTargets = Array.from(
  document.querySelectorAll(".section-heading, .feature-grid article, .steps li, .security-grid article, .guide-grid img"),
);

if (prefersReducedMotion || !("IntersectionObserver" in window)) {
  revealTargets.forEach((item) => item.classList.add("is-visible"));
} else {
  revealTargets.forEach((item) => item.setAttribute("data-reveal", ""));
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    },
    { rootMargin: "0px 0px -8%", threshold: 0.12 },
  );
  revealTargets.forEach((item) => observer.observe(item));
}

const sections = Array.from(document.querySelectorAll("main section[id]"));
const navLinks = Array.from(document.querySelectorAll('.nav-links a[href^="#"]'));
if ("IntersectionObserver" in window) {
  const sectionObserver = new IntersectionObserver(
    (entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;
      navLinks.forEach((link) => link.setAttribute("aria-current", String(link.hash === `#${visible.target.id}`)));
    },
    { rootMargin: "-25% 0px -60%", threshold: [0, 0.2, 0.5] },
  );
  sections.forEach((section) => sectionObserver.observe(section));
}
