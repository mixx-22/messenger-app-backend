require("../models/User"); // ensure model registered before populate(senderId/receiverId)
require("../models/Group");
const Message = require('../models/Message');

exports.createMessage = async (data) => {
  const created = await Message.create(data);
  return Message.findById(created._id)
    .populate('replyTo')
    .populate('senderId', 'name email avatarUrl')
    .populate('receiverId', 'name email avatarUrl')
    .populate('seenBy.userId', 'name email avatarUrl')
    .populate('groupId', 'name avatarUrl members');
};

exports.getInbox = async (userId, skip, limit) => {
  return await Message.find({
    receiverId: userId,
    isDeletedByReceiver: false
  })
    .populate('senderId', 'name email')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit);
};

exports.getSent = async (userId, skip, limit) => {
  return await Message.find({
    senderId: userId,
    isDeletedBySender: false
  })
    .populate('receiverId', 'name email')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit);
};

exports.getConversation = async (userId, otherUserId, skip, limit) => {
  return await Message.find({
    $or: [
      { senderId: userId, receiverId: otherUserId },
      { senderId: otherUserId, receiverId: userId }
    ]
  })
    .sort({ createdAt: 1 })
    .skip(skip)
    .limit(limit)
    .populate('replyTo');
};

/**
 * Chunk of a 1:1 thread in chronological order (oldest → newest in the returned slice).
 * `before` excludes that id and newer; omit for latest window.
 */
exports.getConversationPage = async ({ userId, otherUserId, before, limit }) => {
  const pair = [
    { senderId: userId, receiverId: otherUserId },
    { senderId: otherUserId, receiverId: userId }
  ];

  const filter = before
    ? { $and: [{ $or: pair }, { _id: { $lt: before } }] }
    : { $or: pair };

  const batch = await Message.find(filter)
    .sort({ _id: -1 })
    .limit(limit + 1)
    .populate('replyTo')
    .populate('senderId', 'name email')
    .populate('receiverId', 'name email')
    .populate('seenBy.userId', 'name email avatarUrl');

  const hasMore = batch.length > limit;
  const slice = batch.slice(0, limit).reverse();

  return { items: slice, hasMore };
};

exports.getAnnouncementPage = async ({ before, limit }) => {
  const filter = before
    ? { channel: 'announcement', _id: { $lt: before } }
    : { channel: 'announcement' };

  const batch = await Message.find(filter)
    .sort({ _id: -1 })
    .limit(limit + 1)
    .populate('senderId', 'name email avatarUrl')
    .populate('seenBy.userId', 'name email avatarUrl');

  const hasMore = batch.length > limit;
  const slice = batch.slice(0, limit).reverse();

  return { items: slice, hasMore };
};

exports.getGroupPage = async ({ groupId, before, limit }) => {
  const filter = before
    ? { groupId, channel: 'group', _id: { $lt: before } }
    : { groupId, channel: 'group' };

  const batch = await Message.find(filter)
    .sort({ _id: -1 })
    .limit(limit + 1)
    .populate('replyTo')
    .populate('senderId', 'name email avatarUrl')
    .populate('seenBy.userId', 'name email avatarUrl')
    .populate('groupId', 'name avatarUrl members');

  const hasMore = batch.length > limit;
  const slice = batch.slice(0, limit).reverse();

  return { items: slice, hasMore };
};

exports.countInbox = async (userId) => {
  return await Message.countDocuments({
    receiverId: userId,
    isDeletedByReceiver: false
  });
};

exports.countSent = async (userId) => {
  return await Message.countDocuments({
    senderId: userId,
    isDeletedBySender: false
  });
};

exports.countConversation = async (userId, otherUserId) => {
  return await Message.countDocuments({
    $or: [
      { senderId: userId, receiverId: otherUserId },
      { senderId: otherUserId, receiverId: userId }
    ]
  });
};

exports.getInboxCursor = async (userId, limit, cursor) => {
  const query = {
    receiverId: userId,
    isDeletedByReceiver: false
  };

  if (cursor) {
    query._id = { $lt: cursor }; // pagination cursor
  }

  return await Message.find(query)
    .sort({ _id: -1 })
    .limit(limit)
    .populate('senderId', 'name email')
    .lean();
};

exports.searchMessages = async (userId, keyword, limit) => {
  return await Message.find({
    $text: { $search: keyword },
    $or: [
      { senderId: userId },
      { receiverId: userId }
    ]
  })
    .limit(limit)
    .lean();
};
