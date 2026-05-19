const mongoose = require("mongoose");

const chatStateSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    threadId: { type: String, required: true, trim: true },
    archived: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

chatStateSchema.index({ userId: 1, threadId: 1 }, { unique: true });

module.exports = mongoose.model("ChatState", chatStateSchema);
