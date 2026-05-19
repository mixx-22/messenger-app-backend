const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

exports.register = async (req, res) => {
  try {
    const { name, email, password, department } = req.body;
    const adminCount = await User.countDocuments({
      $or: [{ role: "Administrator" }, { roles: "Administrator" }],
    });
    const role = adminCount === 0 ? "Administrator" : "User";

    const hashed = await bcrypt.hash(password, 10);

    const user = await User.create({
      name,
      email,
      password: hashed,
      department,
      role,
      roles: [role]
    });

    const userSafe = await User.findById(user._id).select('-password');
    res.json(userSafe);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

function createToken(user) {
  const roles = Array.isArray(user.roles) && user.roles.length
    ? user.roles
    : [user.role || "User"];
  return jwt.sign(
    { id: user._id, role: user.role, roles },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "8h" }
  );
}

function userWithoutPassword(user) {
  const safe = typeof user.toObject === "function" ? user.toObject() : { ...user };
  delete safe.password;
  return safe;
}

exports.login = async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim();
    const normalizedEmail = email.toLowerCase();
    const password = String(req.body?.password || "");

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    let user = await User.findOne({ email });
    if (!user && normalizedEmail !== email) {
      user = await User.findOne({ email: normalizedEmail });
    }

    if (!user) {
      const userCount = await User.estimatedDocumentCount();
      if (userCount !== 0) {
        return res.status(400).json({ message: "User not found" });
      }

      const hashed = await bcrypt.hash(password, 10);
      user = await User.create({
        name: normalizedEmail.split("@")[0] || "Administrator",
        email: normalizedEmail,
        password: hashed,
        role: "Administrator",
        roles: ["Administrator"],
      });
    }

    if (user.suspended) {
      return res.status(403).json({
        message: user.suspendReason
          ? `Account suspended: ${user.suspendReason}`
          : "Account suspended",
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: "Invalid password" });

    res.json({ token: createToken(user), user: userWithoutPassword(user) });
  } catch (err) {
    res.status(400).json({ message: err.message || "Login failed" });
  }
};

exports.restoreSession = async (req, res) => {
  try {
    const auth = String(req.headers.authorization || "");
    const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
    if (!token) return res.status(401).json({ message: "No token" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
      ignoreExpiration: true,
    });
    if (!decoded?.id) return res.status(401).json({ message: "Invalid token" });

    const user = await User.findById(decoded.id);
    if (!user) return res.status(401).json({ message: "Invalid user" });
    if (user.suspended) {
      return res.status(403).json({
        message: user.suspendReason
          ? `Account suspended: ${user.suspendReason}`
          : "Account suspended",
      });
    }

    res.json({ token: createToken(user), user: userWithoutPassword(user) });
  } catch {
    res.status(401).json({ message: "Invalid token" });
  }
};
