const AuditLog = require("../models/AuditLog");

exports.listAuditLogs = async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 300);
    const action = typeof req.query.action === "string" ? req.query.action.trim() : "";
    const filter = action ? { action } : {};

    const items = await AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    res.json({ items });
  } catch (err) {
    next(err);
  }
};
