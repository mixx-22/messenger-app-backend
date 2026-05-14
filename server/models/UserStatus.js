const mongoose = require('mongoose');

const userStatusSchema = new mongoose.Schema({
  userId: String,
  isOnline: { type: Boolean, default: false },
  lastSeen: Date
});

module.exports = mongoose.model('UserStatus', userStatusSchema);