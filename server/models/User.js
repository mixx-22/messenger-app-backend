const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: String,
  mustChangePassword: { type: Boolean, default: false },
  passwordChangedAt: { type: Date },
  termsAcceptedAt: { type: Date },
  termsVersion: { type: String, default: '' },
  /** Public URL path from /uploads/... set after image upload */
  avatarUrl: { type: String, default: '' },
  contactNumber: { type: String, default: '' },
  birthday: { type: Date },
  department: String,
  role: {
    type: String,
    enum: ['Administrator', 'Department Head', 'Management', 'User'],
    default: 'User'
  },
  roles: {
    type: [String],
    enum: ['Administrator', 'Department Head', 'Management', 'User'],
    default: ['User']
  },
  status: {
    type: String,
    enum: ['available', 'busy', 'away', 'invisible'],
    default: 'available'
  },
  statusMessage: { type: String, default: '' },
  statusUpdatedAt: { type: Date },
  suspended: { type: Boolean, default: false },
  suspendedAt: { type: Date },
  suspendedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  suspendReason: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
