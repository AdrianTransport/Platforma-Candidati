(() => {
  const type = document.getElementById('portal-tip');
  const fields = document.getElementById('campaign-fields');
  const candidate = document.getElementById('candidate-id');
  const funder = document.getElementById('finantator');
  if (!type || !fields || !candidate || !funder) return;
  function update() {
    const campaign = type.value === 'campanie';
    fields.hidden = !campaign;
    candidate.required = campaign;
    funder.required = campaign;
  }
  type.addEventListener('change', update);
  update();
})();
