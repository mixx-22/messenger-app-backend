const appSettingService = require("../services/appSettingService");
const { recordAudit } = require("../services/auditService");

exports.getAttachmentSettings = async (req, res, next) => {
  try {
    await appSettingService.ensureGlobalSettings();
    const maxAttachmentBytes = await appSettingService.getMaxAttachmentBytes();
    res.json({ maxAttachmentBytes });
  } catch (err) {
    next(err);
  }
};

exports.putAttachmentSettings = async (req, res, next) => {
  try {
    const kib =
      req.body?.maxAttachmentKilobytes !== undefined
        ? Number(req.body.maxAttachmentKilobytes)
        : Number(req.body?.maxAttachmentMegabytes) * 1024;
    if (!Number.isFinite(kib) || kib <= 0) {
      return res.status(400).json({ message: "Valid maxAttachmentKilobytes required" });
    }
    const bytes = Math.round(kib * 1024);
    const maxAttachmentBytes = await appSettingService.setMaxAttachmentBytes(bytes);
    await recordAudit(req, {
      action: "settings.attachment_limit.updated",
      targetType: "settings",
      targetName: "Attachment upload limit",
      details: { maxAttachmentKilobytes: kib, maxAttachmentBytes },
    });
    res.json({ maxAttachmentBytes });
  } catch (err) {
    next(err);
  }
};
