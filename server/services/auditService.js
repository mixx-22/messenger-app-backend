const AuditLog = require("../models/AuditLog");

async function recordAudit(req, entry) {
  try {
    await AuditLog.create({
      actorId: req.user?.id,
      actorName: req.user?.name || req.user?.email || "Unknown",
      action: entry.action,
      targetType: entry.targetType || "",
      targetId: entry.targetId ? String(entry.targetId) : "",
      targetName: entry.targetName || "",
      details: entry.details || {},
    });
  } catch (err) {
    console.error("[audit] failed:", err);
  }
}

module.exports = { recordAudit };
