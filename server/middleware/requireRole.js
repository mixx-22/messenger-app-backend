module.exports = function requireRole(...allowedRoles) {
  return (req, res, next) => {
    const roles = Array.isArray(req.user?.roles) && req.user.roles.length
      ? req.user.roles
      : [req.user?.role].filter(Boolean);
    if (!roles.some((role) => allowedRoles.includes(role))) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    next();
  };
};
