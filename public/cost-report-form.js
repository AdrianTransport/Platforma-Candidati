(() => {
  const blocNume = document.getElementById('bloc_nume');
  const campNume = document.getElementById('camp_nume');
  const acordNume = document.getElementById('acord_nume');
  function actualizeazaModRaspuns() {
    const cuNume = document.getElementById('mod_nume').checked;
    blocNume.style.display = cuNume ? 'block' : 'none';
    campNume.required = cuNume;
    acordNume.required = cuNume;
    if (!cuNume) { campNume.value = ''; acordNume.checked = false; }
  }
  document.getElementById('mod_anonim').addEventListener('change', actualizeazaModRaspuns);
  document.getElementById('mod_nume').addEventListener('change', actualizeazaModRaspuns);
})();
