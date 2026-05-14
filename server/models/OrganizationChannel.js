const mongoose = require('mongoose');

const membershipSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  role: {
    type: String,
    enum: ['Member', 'Co-Admin', 'Admin', 'Main Admin'],
    default: 'Member',
  },
  addedAt: { type: Date, default: Date.now },
  joinedBySelf: { type: Boolean, default: false },
}, { _id: false });

const subjectSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  active: { type: Boolean, default: true },
}, { timestamps: true });

const organizationChannelSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  avatarUrl: { type: String, default: '' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  members: { type: [membershipSchema], default: [] },
  subjects: { type: [subjectSchema], default: [] },
  lastMessageAt: { type: Date, default: Date.now },
}, { timestamps: true });

organizationChannelSchema.index({ 'members.userId': 1, lastMessageAt: -1 });
organizationChannelSchema.index({ createdBy: 1, updatedAt: -1 });

module.exports = mongoose.model('OrganizationChannel', organizationChannelSchema);
