function initializeNavigation() {
  const toggle = document.getElementById("menu-toggle");
  const navigation = document.getElementById("site-nav");
  if (!toggle || !navigation) return;

  function setOpen(open) {
    toggle.setAttribute("aria-expanded", String(open));
    navigation.classList.toggle("is-open", open);
  }

  setOpen(false);
  toggle.addEventListener("click", () => {
    setOpen(toggle.getAttribute("aria-expanded") !== "true");
  });
  navigation.addEventListener("click", (event) => {
    if (event.target.closest?.("a")) setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
      setOpen(false);
      toggle.focus();
    }
  });
}

function initializeSite() {
  document.documentElement.classList.add("js");
  initializeNavigation();
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeSite, { once: true });
  } else {
    initializeSite();
  }
}
