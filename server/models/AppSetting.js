const mongoose = require("mongoose");

const appSettingSchema = new mongoose.Schema(
  {
    key: { type: String, unique: true, required: true },
    maxAttachmentBytes: { type: Number, required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("AppSetting", appSettingSchema);
