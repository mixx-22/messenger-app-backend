const mongoose = require('mongoose');

/* Explicit subdocuments — array-of-object shorthand `[{ url: String }]` compiles as Array<String> in Mongoose 9. */
const attachmentSchema = new mongoose.Schema({
  fileName: String,
  originalName: String,
  url: String,
  mimetype: String,
  type: String, // image | pdf | other
  size: Number,
}, { _id: false });

const reactionSchema = new mongoose.Schema({
  userId: String,
  type: String,
}, { _id: false });

const seenBySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  seenAt: { type: Date, default: Date.now },
}, { _id: false });

const editHistorySchema = new mongoose.Schema({
  content: String,
  editedAt: { type: Date, default: Date.now },
}, { _id: false });

const messageSchema = new mongoose.Schema({
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  receiverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', default: null },
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationChannel', default: null },
  channel: {
    type: String,
    enum: ['direct', 'announcement', 'group', 'organization'],
    default: 'direct'
  },
  replyTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', default: null },
  subject: String,
  content: String,
  organizationMessageType: {
    type: String,
    enum: ['ticket', 'announcement', null],
    default: null,
  },
  attachments: { type: [attachmentSchema], default: [] },
  reactions: { type: [reactionSchema], default: [] },
  seenBy: { type: [seenBySchema], default: [] },
  pinnedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  starredBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  editHistory: { type: [editHistorySchema], default: [] },
  isRead: { type: Boolean, default: false },
  readAt: { type: Date },
  isDeletedBySender: { type: Boolean, default: false },
  isDeletedByReceiver: { type: Boolean, default: false },
  edited: { type: Boolean, default: false },
  editedAt: { type: Date },
  deleted: { type: Boolean, default: false },
  system: { type: Boolean, default: false },
  moderated: { type: Boolean, default: false },
  moderatedAt: { type: Date },
  moderatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  moderationReason: { type: String, default: '' },
}, { timestamps: true });

messageSchema.index({ receiverId: 1, isDeletedByReceiver: 1, createdAt: -1 });
messageSchema.index({ senderId: 1, isDeletedBySender: 1, createdAt: -1 });
messageSchema.index({ senderId: 1, receiverId: 1, _id: -1 });
messageSchema.index({ channel: 1, _id: -1 });
messageSchema.index({ groupId: 1, _id: -1 });
messageSchema.index({ organizationId: 1, _id: -1 });
messageSchema.index({
  subject: 'text',
  content: 'text'
});

module.exports = mongoose.model('Message', messageSchema);
