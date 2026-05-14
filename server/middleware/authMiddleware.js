const jwt = require('jsonwebtoken');
const User = require('../models/User');

module.exports = async (req, res, next) => {
  const token = req.headers.authorization;

  if (!token) return res.status(401).json({ message: 'No token' });

  try {
    const decoded = jwt.verify(token.split(' ')[1], process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');
    if (!user) return res.status(401).json({ message: 'Invalid user' });
    if (user.suspended) {
      return res.status(403).json({
        message: user.suspendReason
          ? `Account suspended: ${user.suspendReason}`
          : 'Account suspended',
      });
    }
    const roles = Array.isArray(user.roles) && user.roles.length
      ? user.roles
      : [user.role || 'User'];
    req.user = {
      id: String(user._id),
      role: user.role,
      roles,
      name: user.name,
      email: user.email
    };
    next();
  } catch {
    res.status(401).json({ message: 'Invalid token' });
  }
};
