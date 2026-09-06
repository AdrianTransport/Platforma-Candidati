export function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.redirect('/login');
  }
  next();
}

export function requireRole(rol) {
  return (req, res, next) => {
    if (!req.session.userId || req.session.rol !== rol) {
      return res.status(403).send('Nu ai acces la aceasta pagina.');
    }
    next();
  };
}
