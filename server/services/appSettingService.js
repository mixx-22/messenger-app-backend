const AppSetting = require("../models/AppSetting");

const GLOBAL_KEY = "global";

function defaultBytesFromEnv() {
  const mb = Number(process.env.MAX_UPLOAD_MB);
  const mib = Number.isFinite(mb) && mb > 0 ? mb : 200;
  return Math.round(mib * 1024 * 1024);
}

exports.ensureGlobalSettings = async () => {
  const existing = await AppSetting.findOne({ key: GLOBAL_KEY });
  if (existing) return existing;
  return AppSetting.create({
    key: GLOBAL_KEY,
    maxAttachmentBytes: defaultBytesFromEnv(),
  });
};

exports.getMaxAttachmentBytes = async () => {
  const doc =
    (await AppSetting.findOne({ key: GLOBAL_KEY })) ||
    (await exports.ensureGlobalSettings());
  const n = Number(doc.maxAttachmentBytes);
  if (!Number.isFinite(n) || n <= 0) return defaultBytesFromEnv();
  return n;
};

exports.setMaxAttachmentBytes = async (bytes) => {
  const n = Math.round(Number(bytes));
  const maxCap = parseInt(process.env.MAX_UPLOAD_HARD_CAP_MB || "1024", 10);
  const capBytes =
    Number.isFinite(maxCap) && maxCap > 0
      ? Math.round(maxCap * 1024 * 1024)
      : 1024 * 1024 * 1024;
  const safe =
    Number.isFinite(n) && n > 0 ? Math.min(n, capBytes) : defaultBytesFromEnv();
  await AppSetting.findOneAndUpdate(
    { key: GLOBAL_KEY },
    { key: GLOBAL_KEY, maxAttachmentBytes: safe },
    { upsert: true, new: true }
  );
  return safe;
};
