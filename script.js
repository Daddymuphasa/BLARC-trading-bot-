const header = document.querySelector(".site-header");
const tabs = Array.from(document.querySelectorAll(".tab"));
const panels = Array.from(document.querySelectorAll(".product-panel"));
const accordionButtons = Array.from(document.querySelectorAll(".accordion button"));

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

window.addEventListener("scroll", setHeaderState, { passive: true });
setHeaderState();
