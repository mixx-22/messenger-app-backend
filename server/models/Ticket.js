const mongoose = require('mongoose');

const ticketAttachmentSchema = new mongoose.Schema({
  fileName: String,
  originalName: String,
  url: String,
  mimetype: String,
  type: String,
  size: Number,
}, { _id: false });

const ticketHistorySchema = new mongoose.Schema({
  action: String,
  fromStatus: String,
  toStatus: String,
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  actorName: String,
  note: String,
  attachments: { type: [ticketAttachmentSchema], default: [] },
  createdAt: { type: Date, default: Date.now },
}, { _id: false });

const ticketSchema = new mongoose.Schema({
  organizationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'OrganizationChannel',
    required: true,
  },
  ticketNumber: { type: String, unique: true, sparse: true },
  requestorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdForId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  subject: { type: String, required: true, trim: true },
  description: { type: String, required: true },
  dateNeeded: { type: Date, required: true },
  status: {
    type: String,
    enum: ['pending', 'accepted', 'in_progress', 'waiting', 'verify', 'resolved', 'closed', 'invalid'],
    default: 'pending',
  },
  actionTaken: { type: String, default: '' },
  verificationComment: { type: String, default: '' },
  priority: {
    type: String,
    enum: ['low', 'normal', 'high', 'urgent'],
    default: 'normal',
  },
  assigneeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  messageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
  attachments: { type: [ticketAttachmentSchema], default: [] },
  history: { type: [ticketHistorySchema], default: [] },
}, { timestamps: true });

ticketSchema.index({ organizationId: 1, status: 1, updatedAt: -1 });
ticketSchema.index({ requestorId: 1, updatedAt: -1 });
ticketSchema.index({ createdForId: 1, updatedAt: -1 });

module.exports = mongoose.model('Ticket', ticketSchema);
