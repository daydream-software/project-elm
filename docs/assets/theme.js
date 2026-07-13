/* Applies the current theme to every `.shot-themed` screenshot (setting `src` from
 * `data-dark`/`data-light` — never both, unlike a dark+light <img> pair with one
 * hidden via CSS, which the browser fetches regardless of display:none) and wires
 * up the #theme-toggle button. */
function applyShotImages() {
  const light = document.documentElement.getAttribute('data-theme') === 'light';
  document.querySelectorAll('.shot-themed').forEach((img) => {
    const want = light ? img.dataset.light : img.dataset.dark;
    if (img.getAttribute('src') !== want) img.src = want;
  });
}
applyShotImages();

document.getElementById('theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  if (next === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
  try { localStorage.setItem('elm-docs.theme', next); } catch {}
  applyShotImages();
});
