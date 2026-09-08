// Highlights the nav link matching the section currently in view.
// Safe to include on every page: it no-ops if #home / .site-nav aren't present.
document.addEventListener('DOMContentLoaded', function () {
  var navLinks = document.querySelectorAll('.site-nav__link');
  var sections = Array.prototype.map.call(navLinks, function (link) {
    var id = link.getAttribute('href').replace('#', '');
    return document.getElementById(id);
  }).filter(Boolean);

  if (!sections.length) return;

  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      navLinks.forEach(function (link) {
        link.classList.toggle('is-active', link.getAttribute('href') === '#' + entry.target.id);
      });
    });
  }, { rootMargin: '-50% 0px -50% 0px' });

  sections.forEach(function (section) {
    observer.observe(section);
  });
});
