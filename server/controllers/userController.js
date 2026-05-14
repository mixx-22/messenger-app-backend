const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { recordAudit } = require('../services/auditService');

const USER_ROLES = new Set(['Administrator', 'Department Head', 'Management', 'User']);
const USER_STATUSES = new Set(['available', 'busy', 'away', 'invisible']);
const TEMP_PASSWORD_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const CURRENT_TERMS_VERSION = '2026-05-10';

function normalizeRole(role) {
  return USER_ROLES.has(role) ? role : 'User';
}

function normalizeRoles(value) {
  const rows = Array.isArray(value) ? value : [value];
  const roles = rows
    .map((role) => String(role || '').trim())
    .filter((role) => USER_ROLES.has(role));
  return [...new Set(roles.length ? roles : ['User'])];
}

function primaryRoleFromRoles(roles) {
  if (roles.includes('Administrator')) return 'Administrator';
  if (roles.includes('Department Head')) return 'Department Head';
  if (roles.includes('Management')) return 'Management';
  return roles[0] || 'User';
}

function hasAdministratorRole(user) {
  const roles = Array.isArray(user?.roles) && user.roles.length
    ? user.roles
    : [user?.role].filter(Boolean);
  return roles.includes('Administrator');
}

async function otherAdministratorCount(userId) {
  return User.countDocuments({
    _id: { $ne: userId },
    $or: [{ role: 'Administrator' }, { roles: 'Administrator' }],
  });
}

function generateTemporaryPassword(length = 8) {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += TEMP_PASSWORD_CHARS[Math.floor(Math.random() * TEMP_PASSWORD_CHARS.length)];
  }
  return out;
}

exports.updateMyProfile = async (req, res, next) => {
  try {
    const { avatarUrl, contactNumber, birthday } = req.body || {};
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (avatarUrl !== undefined) {
      if (typeof avatarUrl !== 'string') {
        return res.status(400).json({ message: 'avatarUrl must be a string' });
      }
      const v = avatarUrl.trim();
      if (v.length > 512) {
        return res.status(400).json({ message: 'avatarUrl too long' });
      }
      user.avatarUrl = v;
    }

    if (contactNumber !== undefined) {
      if (typeof contactNumber !== 'string') {
        return res.status(400).json({ message: 'contactNumber must be a string' });
      }
      user.contactNumber = contactNumber.trim().slice(0, 40);
    }

    if (birthday !== undefined) {
      if (birthday === '' || birthday === null) {
        user.birthday = undefined;
      } else {
        const value = new Date(birthday);
        if (Number.isNaN(value.getTime())) {
          return res.status(400).json({ message: 'birthday must be a valid date' });
        }
        user.birthday = value;
      }
    }

    await user.save();
    const safe = await User.findById(user._id).select('-password');
    res.json(safe);
  } catch (err) {
    next(err);
  }
};

exports.updateMyStatus = async (req, res, next) => {
  try {
    const status = String(req.body?.status || '').trim();
    const statusMessage =
      typeof req.body?.statusMessage === 'string'
        ? req.body.statusMessage.trim().slice(0, 100)
        : '';

    if (!USER_STATUSES.has(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    user.status = status;
    user.statusMessage = status === 'invisible' ? '' : statusMessage;
    user.statusUpdatedAt = new Date();
    await user.save();

    const safe = await User.findById(user._id).select('-password');
    const io = req.app.get('io');
    if (io) {
      io.emit('user_status', {
        userId: String(user._id),
        status: user.status,
        statusMessage: user.statusMessage,
        statusUpdatedAt: user.statusUpdatedAt,
      });
    }

    res.json(safe);
  } catch (err) {
    next(err);
  }
};

exports.changeMyPassword = async (req, res, next) => {
  try {
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');
    if (!currentPassword || !newPassword || newPassword.length < 8) {
      return res.status(400).json({ message: 'Current password and an 8+ character new password are required' });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const matches = await bcrypt.compare(currentPassword, user.password);
    if (!matches) return res.status(400).json({ message: 'Current password is incorrect' });

    user.password = await bcrypt.hash(newPassword, 10);
    user.mustChangePassword = false;
    user.passwordChangedAt = new Date();
    await user.save();

    const safe = await User.findById(user._id).select('-password');
    res.json(safe);
  } catch (err) {
    next(err);
  }
};

exports.acceptMyTerms = async (req, res, next) => {
  try {
    if (req.body?.agreed !== true) {
      return res.status(400).json({ message: 'Agreement is required to continue' });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    user.termsAcceptedAt = new Date();
    user.termsVersion = CURRENT_TERMS_VERSION;
    await user.save();

    const safe = await User.findById(user._id).select('-password');
    res.json(safe);
  } catch (err) {
    next(err);
  }
};

exports.listUsers = async (req, res, next) => {
  try {
    const users = await User.find().select('-password').sort({ createdAt: -1 });
    res.json(users);
  } catch (err) {
    next(err);
  }
};

exports.createUser = async (req, res, next) => {
  try {
    const { name, email, department, role, roles } = req.body;
    if (!name || !email) {
      return res.status(400).json({ message: 'name and email are required' });
    }

    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(400).json({ message: 'Email already used' });
    }

    const temporaryPassword = generateTemporaryPassword();
    const hashed = await bcrypt.hash(temporaryPassword, 10);
    const normalizedRoles = normalizeRoles(roles !== undefined ? roles : role);
    const user = await User.create({
      name: String(name).trim(),
      email: String(email).trim(),
      password: hashed,
      mustChangePassword: true,
      department: department || '',
      role: primaryRoleFromRoles(normalizedRoles),
      roles: normalizedRoles
    });
    const safe = await User.findById(user._id).select('-password');
    await recordAudit(req, {
      action: 'user.created',
      targetType: 'user',
      targetId: user._id,
      targetName: user.email,
      details: { roles: user.roles, department: user.department || '' },
    });
    res.status(201).json({ user: safe, temporaryPassword });
  } catch (err) {
    next(err);
  }
};

exports.updateUser = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, email, department, role, roles } = req.body;
    const user = await User.findById(id);

    if (!user) return res.status(404).json({ message: 'User not found' });

    if (name !== undefined) user.name = name;
    if (email !== undefined) user.email = email;
    if (department !== undefined) user.department = department;
    if (roles !== undefined || role !== undefined) {
      const normalizedRoles = normalizeRoles(roles !== undefined ? roles : role);
      if (
        hasAdministratorRole(user) &&
        !normalizedRoles.includes('Administrator') &&
        (await otherAdministratorCount(user._id)) === 0
      ) {
        return res.status(400).json({ message: 'At least one Administrator is required' });
      }
      user.roles = normalizedRoles;
      user.role = primaryRoleFromRoles(normalizedRoles);
    }

    await user.save();
    const safe = await User.findById(user._id).select('-password');
    await recordAudit(req, {
      action: 'user.updated',
      targetType: 'user',
      targetId: user._id,
      targetName: user.email,
      details: { roles: user.roles, department: user.department || '' },
    });
    res.json(safe);
  } catch (err) {
    next(err);
  }
};

exports.resetUserPassword = async (req, res, next) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const temporaryPassword = generateTemporaryPassword();
    user.password = await bcrypt.hash(temporaryPassword, 10);
    user.mustChangePassword = true;
    user.passwordChangedAt = null;
    await user.save();

    const safe = await User.findById(user._id).select('-password');
    await recordAudit(req, {
      action: 'user.password_reset',
      targetType: 'user',
      targetId: user._id,
      targetName: user.email,
      details: { temporary: true },
    });
    res.json({ user: safe, temporaryPassword });
  } catch (err) {
    next(err);
  }
};

exports.setUserSuspension = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (String(req.user.id) === String(id)) {
      return res.status(400).json({ message: 'You cannot suspend your own account' });
    }

    const suspended = Boolean(req.body?.suspended);
    const reason =
      typeof req.body?.reason === 'string'
        ? req.body.reason.trim().slice(0, 300)
        : '';
    const user = await User.findById(id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    user.suspended = suspended;
    user.suspendedAt = suspended ? new Date() : null;
    user.suspendedBy = suspended ? req.user.id : null;
    user.suspendReason = suspended ? reason : '';
    await user.save();

    const safe = await User.findById(user._id).select('-password');
    await recordAudit(req, {
      action: suspended ? 'user.suspended' : 'user.unsuspended',
      targetType: 'user',
      targetId: user._id,
      targetName: user.email,
      details: { reason: user.suspendReason },
    });

    const io = req.app.get('io');
    if (io) {
      io.emit('user:suspension', {
        userId: String(user._id),
        suspended: user.suspended,
      });
    }

    res.json(safe);
  } catch (err) {
    next(err);
  }
};

exports.deleteUser = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (String(req.user.id) === String(id)) {
      return res.status(400).json({ message: 'You cannot delete your own account' });
    }
    const deleted = await User.findById(id);
    if (!deleted) return res.status(404).json({ message: 'User not found' });
    if (hasAdministratorRole(deleted) && (await otherAdministratorCount(deleted._id)) === 0) {
      return res.status(400).json({ message: 'At least one Administrator is required' });
    }
    await deleted.deleteOne();
    await recordAudit(req, {
      action: 'user.deleted',
      targetType: 'user',
      targetId: deleted._id,
      targetName: deleted.email,
      details: { roles: deleted.roles?.length ? deleted.roles : [deleted.role], department: deleted.department || '' },
    });
    res.json({ success: true, id });
  } catch (err) {
    next(err);
  }
};
