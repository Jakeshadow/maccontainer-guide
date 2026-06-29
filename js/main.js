// MacContainer.dev — main.js
(function () {
  'use strict';

  // Mobile nav toggle
  var toggle = document.getElementById('nav-toggle');
  var links = document.getElementById('nav-links');
  if (toggle && links) {
    toggle.addEventListener('click', function () {
      links.classList.toggle('open');
    });
  }

  // Highlight current page in nav
  var currentPath = window.location.pathname.replace(/\/$/, '') || '/';
  var navAs = document.querySelectorAll('.nav-links a:not(.nav-cta)');
  navAs.forEach(function (a) {
    var href = a.getAttribute('href');
    if (href === currentPath || (href !== '/' && currentPath.startsWith(href))) {
      a.classList.add('active');
    }
  });
})();
