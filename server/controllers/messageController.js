const mongoose = require("mongoose");
const Message = require("../models/Message");
const Notification = require("../models/Notification");
const User = require("../models/User");
const Group = require("../models/Group");
const OrganizationChannel = require("../models/OrganizationChannel");
const ChatState = require("../models/ChatState");
const messageService = require("../services/messageService");
const { recordAudit } = require("../services/auditService");

const ANNOUNCEMENT_ROLES = new Set(["Administrator", "Management"]);
const GROUP_THREAD_PREFIX = "group:";

function hasAnyRole(user, allowedRoles) {
  const roles = Array.isArray(user?.roles) && user.roles.length
    ? user.roles
    : [user?.role].filter(Boolean);
  return roles.some((role) => allowedRoles.has(role));
}

/** Accepts hex string or common nested JSON shapes; rejects invalid IDs. */
function toObjectIdOrNull(value) {
  if (value == null || value === "") return null;

  if (Array.isArray(value) && value.length === 1) {
    return toObjectIdOrNull(value[0]);
  }

  if (typeof value === "object") {
    if (value instanceof mongoose.Types.ObjectId) return value;
    if (value._bsontype === "ObjectId") {
      const hex = typeof value.toHexString === "function"
        ? value.toHexString()
        : String(value);
      return toObjectIdOrNull(hex);
    }
    if (typeof value.$oid === "string") return toObjectIdOrNull(value.$oid);
    if (value._id != null && value._id !== value) return toObjectIdOrNull(value._id);
    if (value.id != null) return toObjectIdOrNull(value.id);
    if (typeof value.toString === "function") {
      const s = value.toString();
      if (s !== "[object Object]") return toObjectIdOrNull(s);
    }
    return null;
  }

  const s = String(value).trim().replace(/^["']|["']$/g, "");
  if (!/^[a-fA-F0-9]{24}$/.test(s)) return null;
  try {
    return new mongoose.Types.ObjectId(s);
  } catch {
    return null;
  }
}

function optionalPlainString(value) {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  return undefined;
}

/** Chat body text must be a real string — arrays/objects would Mongoose-cast to 400. */
function asMessageContent(value) {
  if (typeof value === "string") return value;
  if (
    value != null &&
    typeof value !== "object" &&
    (typeof value === "number" ||
      typeof value === "boolean" ||
      typeof value === "bigint")
  ) {
    return String(value);
  }
  return "";
}

/**
 * Accept JSON arrays, double-encoded JSON strings, or string elements that are JSON objects.
 * Rejects nested arrays and non-objects so Mongoose never sees attachments[0] as a string blob.
 */
function coerceAttachmentsArray(raw) {
  if (raw == null || raw === "") return [];

  let list = raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      list = parsed;
    } catch {
      return [];
    }
  }

  if (!Array.isArray(list)) return [];

  const out = [];
  for (const item of list) {
    if (item == null) continue;

    if (typeof item === "string") {
      try {
        const parsed = JSON.parse(item);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          out.push(parsed);
        }
      } catch {
        /* skip invalid JSON fragment */
      }
      continue;
    }

    if (typeof item === "object" && !Array.isArray(item)) {
      out.push(item);
    }
  }

  return out;
}

function sanitizeAttachments(raw) {
  const arr = coerceAttachmentsArray(raw);
  const types = new Set(["image", "pdf", "other"]);
  const asStr = (v) =>
    typeof v === "string" ? v : v != null && typeof v !== "object" ? String(v) : "";
  return arr
    .map((a) => {
      if (!a || typeof a !== "object" || Array.isArray(a)) return null;
      const type = types.has(String(a.type)) ? String(a.type) : "other";
      const size = Number(a.size);
      const row = {
        fileName: asStr(a.fileName),
        originalName: asStr(a.originalName),
        url: asStr(a.url),
        mimetype: asStr(a.mimetype),
        type,
        ...(Number.isFinite(size) && size >= 0 ? { size } : {}),
      };
      const hasRef =
        (row.url && row.url.trim() !== "") ||
        (row.fileName && row.fileName.trim() !== "");
      return hasRef ? row : null;
    })
    .filter(Boolean);
}

function idFromRef(ref) {
  if (ref == null) return "";
  if (typeof ref === "object") return String(ref._id || ref.id || "");
  return String(ref);
}

function directThreadIdForUsers(a, b) {
  const ids = [String(a || ""), String(b || "")].filter(Boolean).sort();
  return ids.length === 2 ? `${ids[0]}:${ids[1]}` : "";
}

function groupThreadIdFor(groupId) {
  return `${GROUP_THREAD_PREFIX}${idFromRef(groupId)}`;
}

async function chatStateFor(userId, threadId) {
  if (!threadId) return null;
  return ChatState.findOne({ userId, threadId }).lean();
}

function serializeMessage(message) {
  if (!message) return null;
  const raw =
    typeof message.toObject === "function"
      ? message.toObject({ depopulate: false, versionKey: false })
      : { ...message };

  return {
    ...raw,
    _id: idFromRef(raw._id),
    senderId: raw.senderId,
    receiverId: raw.receiverId,
    groupId: raw.groupId || null,
    organizationId: raw.organizationId || null,
    channel: raw.channel || "direct",
    organizationMessageType: raw.organizationMessageType || null,
    replyTo: raw.replyTo || null,
    attachments: Array.isArray(raw.attachments) ? raw.attachments : [],
    reactions: Array.isArray(raw.reactions) ? raw.reactions : [],
    seenBy: Array.isArray(raw.seenBy) ? raw.seenBy : [],
    pinnedBy: Array.isArray(raw.pinnedBy) ? raw.pinnedBy : [],
    starredBy: Array.isArray(raw.starredBy) ? raw.starredBy : [],
    editHistory: Array.isArray(raw.editHistory) ? raw.editHistory : [],
    system: Boolean(raw.system),
  };
}

async function findMessageWithPeers(messageId) {
  return Message.findById(messageId)
    .populate("replyTo")
    .populate("senderId", "name email avatarUrl")
    .populate("receiverId", "name email avatarUrl")
    .populate("seenBy.userId", "name email avatarUrl")
    .populate("groupId", "name avatarUrl members")
    .populate("organizationId", "name avatarUrl members subjects");
}

async function findGroupForMember(groupId, userId) {
  const oid = toObjectIdOrNull(groupId);
  if (!oid) return null;
  return Group.findOne({ _id: oid, members: userId }).select("name members avatarUrl");
}

async function findOrganizationForMember(organizationId, userId) {
  const oid = toObjectIdOrNull(organizationId);
  if (!oid) return null;
  return OrganizationChannel.findOne({ _id: oid, "members.userId": userId }).select("name members avatarUrl subjects");
}

/* =========================
   SEND MESSAGE (UPDATED)
========================= */
exports.sendMessage = async (req, res, next) => {
  try {
    const raw = req.body || {};
    const receiverId = raw.receiverId;
    const replyTo = raw.replyTo;
    const subject = optionalPlainString(raw.subject);
    const clientId = optionalPlainString(raw.clientId);
    const content = asMessageContent(raw.content);

    const sanitized = sanitizeAttachments(raw.attachments);
    const hasAttachments = sanitized.length > 0;

    const missingReceiver = receiverId == null || receiverId === "";

    if (missingReceiver || (!content.trim() && !hasAttachments)) {
      return res.status(400).json({
        message: "receiverId and message body or attachment required",
      });
    }

    const receiverOid = toObjectIdOrNull(receiverId);

    if (!receiverOid) {
      return res.status(400).json({ message: "Invalid receiverId" });
    }

    const replyOid = toObjectIdOrNull(replyTo);

    // =========================
    // SAVE MESSAGE
    // =========================
    const message = await messageService.createMessage({
      senderId: req.user.id,
      receiverId: receiverOid,
      subject,
      content,
      attachments: sanitized,
      replyTo: replyOid,
    });

    // =========================
    // NOTIFICATION
    // =========================
    const preview = content.trim()
      ? content
      : hasAttachments
      ? "Attachment"
      : "";

    const notificationTitle =
      subject != null && String(subject).trim() !== ""
        ? subject.trim()
        : "New Message";

    await new Notification({
      userId: receiverOid,
      type: "message",
      title: notificationTitle,
      body: preview,
    }).save();

    // =========================
    // 🔥 SOCKET EMIT (THIS FIXES YOUR SIDEBAR)
    // =========================
    const io = req.app.get("io");

    if (io) {
      const senderRoom = idFromRef(message?.senderId);
      const receiverRoom = idFromRef(message?.receiverId);
      const payload = {
        ...serializeMessage(message),
        ...(clientId ? { clientId } : {}),
      };

      // send to both sender and receiver rooms
      if (receiverRoom) io.to(receiverRoom).emit("message:new", payload);
      if (senderRoom) io.to(senderRoom).emit("message:new", payload);
    }

    // =========================
    // RESPONSE
    // =========================
    res.json({
      ...serializeMessage(message),
      ...(clientId ? { clientId } : {}),
    });
  } catch (err) {
    next(err);
  }
};

exports.getInbox = async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      messageService.getInbox(req.user.id, skip, limit),
      messageService.countInbox(req.user.id)
    ]);

    res.json({
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(Math.ceil(total / limit), 1)
      }
    });
  } catch (err) {
    next(err);
  }
};

exports.getSent = async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      messageService.getSent(req.user.id, skip, limit),
      messageService.countSent(req.user.id)
    ]);

    res.json({
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(Math.ceil(total / limit), 1)
      }
    });
  } catch (err) {
    next(err);
  }
};

exports.getConversation = async (req, res, next) => {
  try {
    const { userId: otherUserId } = req.params;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 40, 1), 100);
    const before = typeof req.query.before === "string" && req.query.before.trim()
      ? req.query.before.trim()
      : undefined;
    const legacyPageRequested = typeof req.query.page !== "undefined" && before === undefined;
    const state = await chatStateFor(
      req.user.id,
      directThreadIdForUsers(req.user.id, otherUserId),
    );

    if (!legacyPageRequested) {
      const { items, hasMore } = await messageService.getConversationPage({
        userId: req.user.id,
        otherUserId,
        before,
        limit,
        after: state?.deletedAt || null,
      });

      const nextOlderCursor =
        hasMore && items.length ? String(items[0]._id) : null;

      return res.json({
        items,
        pagination: {
          limit,
          hasMore,
          nextOlderCursor,
          mode: "cursor"
        }
      });
    }

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      messageService.getConversation(req.user.id, otherUserId, skip, limit),
      messageService.countConversation(req.user.id, otherUserId)
    ]);

    res.json({
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(Math.ceil(total / limit), 1),
        mode: "page"
      }
    });
  } catch (err) {
    next(err);
  }
};

exports.getUnreadBySender = async (req, res, next) => {
  try {
    const mongoose = require("mongoose");
    const oid = new mongoose.Types.ObjectId(req.user.id);
    const rows = await Message.aggregate([
      {
        $match: {
          receiverId: oid,
          isRead: false,
          isDeletedByReceiver: false
        }
      },
      {
        $group: {
          _id: "$senderId",
          count: { $sum: 1 }
        }
      }
    ]);

    const map = Object.fromEntries(
      rows.map((r) => [String(r._id), r.count])
    );

    res.json(map);
  } catch (err) {
    next(err);
  }
};

/* =========================
   EDIT MESSAGE
========================= */
exports.editMessage = async (req, res, next) => {
  try {
    const content = asMessageContent(req.body?.content);
    const messageId = req.params.id || req.body.messageId;

    // ✅ Validate input
    if (!content.trim()) {
      return res.status(400).json({ message: "Content is required" });
    }

    const message = await Message.findById(messageId);

    if (!message) {
      return res.status(404).json({ message: "Message not found" });
    }

    // 🔒 only sender can edit
    if (message.senderId.toString() !== req.user.id) {
      return res.status(403).json({ message: "Not allowed" });
    }

    // ⚡ prevent unnecessary update
    if (message.content === content.trim()) {
      return res.status(200).json({
        message,
        info: "No changes detected"
      });
    }

    message.editHistory = Array.isArray(message.editHistory) ? message.editHistory : [];
    message.editHistory.push({
      content: message.content,
      editedAt: new Date(),
    });

    message.content = content.trim();
    message.edited = true;
    message.editedAt = new Date();

    await message.save();
    const populated = await findMessageWithPeers(message._id);
    const payload = serializeMessage(populated);
    const io = req.app.get("io");

    if (io) emitMessageUpdate(io, populated, payload, "message:updated");

    res.json({
      success: true,
      message: payload
    });

  } catch (err) {
    next(err);
  }
};

/* =========================
   DELETE MESSAGE
========================= */
exports.deleteMessage = async (req, res, next) => {
  try {
    const messageId = req.params.messageId || req.params.id;

    const message = await Message.findById(messageId);

    if (!message) {
      return res.status(404).json({ message: "Message not found" });
    }

    // 🔒 only sender can delete
    if (message.senderId.toString() !== req.user.id) {
      return res.status(403).json({ message: "Not allowed" });
    }

    // Soft delete for sender mailbox; keeps thread integrity.
    message.isDeletedBySender = true;
    message.deleted = true;
    message.content = "This message was deleted";
    message.attachments = [];
    message.reactions = [];

    await message.save();

    res.json({
      success: true,
      messageId,
      deletedBySender: true
    });

  } catch (err) {
    next(err);
  }
};

/* =========================
   REACT TO MESSAGE
========================= */
exports.reactToMessage = async (req, res, next) => {
  try {
    const { messageId, type } = req.body;
    const allowedReactions = new Set(["like", "love", "haha", "wow", "sad", "angry"]);
    const reactionType = typeof type === "string" ? type.trim() : "";

    if (!messageId || !toObjectIdOrNull(messageId)) {
      return res.status(400).json({ message: "Valid messageId is required" });
    }

    if (!allowedReactions.has(reactionType)) {
      return res.status(400).json({ message: "Valid reaction type is required" });
    }

    const message = await Message.findById(messageId);

    if (!message) {
      return res.status(404).json({ message: "Message not found" });
    }

    const currentUserId = String(req.user.id);

    if (message.channel === "group") {
      const group = await findGroupForMember(message.groupId, currentUserId);
      if (!group) {
        return res.status(403).json({ message: "Not allowed" });
      }
    }

    if (!(await userCanAccessMessage(message, currentUserId))) {
      return res.status(403).json({ message: "Not allowed" });
    }

    if (message.deleted) {
      return res.status(400).json({ message: "Cannot react to a deleted message" });
    }

    if (!message.reactions) {
      message.reactions = [];
    }

    const existingReaction = message.reactions.find(
      (r) => r.userId.toString() === req.user.id
    );

    if (existingReaction) {
      if (existingReaction.type === reactionType) {
        message.reactions = message.reactions.filter(
          (r) => String(r.userId) !== currentUserId
        );
      } else {
        existingReaction.type = reactionType;
      }
    } else {
      message.reactions.push({
        userId: currentUserId,
        type: reactionType
      });
    }

    await message.save();
    const populated = await findMessageWithPeers(message._id);
    const payload = serializeMessage(populated);
    const io = req.app.get("io");

    if (io) {
      if (payload?.channel === "announcement") {
        io.emit("message:reaction", payload);
      } else if (payload?.channel === "group") {
        const group = populated?.groupId;
        const members = Array.isArray(group?.members) ? group.members : [];
        members.forEach((memberId) => {
          io.to(String(memberId)).emit("message:reaction", payload);
        });
      } else if (payload?.channel === "organization") {
        const members = Array.isArray(populated?.organizationId?.members)
          ? populated.organizationId.members
          : [];
        members.forEach((member) => {
          const memberId = idFromRef(member?.userId || member);
          if (memberId) io.to(memberId).emit("message:reaction", payload);
        });
      } else {
        const senderRoom = idFromRef(populated?.senderId);
        const receiverRoom = idFromRef(populated?.receiverId);
        if (senderRoom) io.to(senderRoom).emit("message:reaction", payload);
        if (receiverRoom) io.to(receiverRoom).emit("message:reaction", payload);
      }
    }

    res.json(payload);
  } catch (err) {
    next(err);
  }
};

async function userCanAccessMessage(message, userId) {
  const uid = String(userId);
  if (message.channel === "announcement") return true;
  if (message.channel === "group") return true;
  if (message.channel === "organization") {
    return Boolean(await findOrganizationForMember(message.organizationId, userId));
  }
  return String(message.senderId || "") === uid || String(message.receiverId || "") === uid;
}

function emitMessageUpdate(io, populated, payload, eventName) {
  if (!io || !payload) return;
  if (payload.channel === "announcement") {
    io.emit(eventName, payload);
    return;
  }
  if (payload.channel === "group") {
    const members = Array.isArray(populated?.groupId?.members)
      ? populated.groupId.members
      : [];
    members.forEach((memberId) => io.to(String(memberId)).emit(eventName, payload));
    return;
  }
  if (payload.channel === "organization") {
    const members = Array.isArray(populated?.organizationId?.members)
      ? populated.organizationId.members
      : [];
    members.forEach((member) => {
      const memberId = idFromRef(member?.userId || member);
      if (memberId) io.to(memberId).emit(eventName, payload);
    });
    return;
  }
  const senderRoom = idFromRef(populated?.senderId);
  const receiverRoom = idFromRef(populated?.receiverId);
  if (senderRoom) io.to(senderRoom).emit(eventName, payload);
  if (receiverRoom) io.to(receiverRoom).emit(eventName, payload);
}

exports.togglePinMessage = async (req, res, next) => {
  try {
    const message = await Message.findById(req.body?.messageId);
    if (!message) return res.status(404).json({ message: "Message not found" });
    if (
      !(await userCanAccessMessage(message, req.user.id)) ||
      (message.channel === "group" && !(await findGroupForMember(message.groupId, req.user.id)))
    ) {
      return res.status(403).json({ message: "Not allowed" });
    }

    const uid = String(req.user.id);
    const current = (message.pinnedBy || []).map(String);
    message.pinnedBy = current.includes(uid)
      ? current.filter((id) => id !== uid)
      : [...current, uid];
    await message.save();

    const populated = await findMessageWithPeers(message._id);
    const payload = serializeMessage(populated);
    emitMessageUpdate(req.app.get("io"), populated, payload, "message:updated");
    res.json(payload);
  } catch (err) {
    next(err);
  }
};

exports.toggleStarMessage = async (req, res, next) => {
  try {
    const message = await Message.findById(req.body?.messageId);
    if (!message) return res.status(404).json({ message: "Message not found" });
    if (
      !(await userCanAccessMessage(message, req.user.id)) ||
      (message.channel === "group" && !(await findGroupForMember(message.groupId, req.user.id)))
    ) {
      return res.status(403).json({ message: "Not allowed" });
    }

    const uid = String(req.user.id);
    const current = (message.starredBy || []).map(String);
    message.starredBy = current.includes(uid)
      ? current.filter((id) => id !== uid)
      : [...current, uid];
    await message.save();

    const populated = await findMessageWithPeers(message._id);
    const payload = serializeMessage(populated);
    emitMessageUpdate(req.app.get("io"), populated, payload, "message:updated");
    res.json(payload);
  } catch (err) {
    next(err);
  }
};

exports.searchMessages = async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const hasFiles = req.query.hasFiles === "true";
    const senderOid = toObjectIdOrNull(req.query.senderId);
    const dateFrom = req.query.dateFrom ? new Date(req.query.dateFrom) : null;
    const dateTo = req.query.dateTo ? new Date(req.query.dateTo) : null;
    const sidebarMode = req.query.sidebar === "true";

    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 50, 1),
      sidebarMode ? 300 : 100
    );
    const groupId = req.query.groupId;
    const peerId = req.query.peerId;
    const channel = req.query.channel;

    let filter = { deleted: { $ne: true } };

    if (q && !sidebarMode) {
      filter.content = {
        $regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        $options: "i",
      };
    }

    if (hasFiles) filter["attachments.0"] = { $exists: true };
    if (senderOid) filter.senderId = senderOid;

    if (
      (dateFrom && !Number.isNaN(dateFrom.getTime())) ||
      (dateTo && !Number.isNaN(dateTo.getTime()))
    ) {
      filter.createdAt = {};
      if (dateFrom && !Number.isNaN(dateFrom.getTime())) {
        filter.createdAt.$gte = dateFrom;
      }
      if (dateTo && !Number.isNaN(dateTo.getTime())) {
        const end = new Date(dateTo);
        end.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = end;
      }
    }

    if (!sidebarMode && !q && !hasFiles && !senderOid && !filter.createdAt) {
      return res.json({ items: [] });
    }

    if (channel === "announcement") {
      filter.channel = "announcement";
    } else if (groupId) {
      const group = await findGroupForMember(groupId, req.user.id);
      if (!group) return res.status(404).json({ message: "Group not found" });
      filter.channel = "group";
      filter.groupId = group._id;
    } else if (peerId) {
      const otherOid = toObjectIdOrNull(peerId);
      if (!otherOid) return res.status(400).json({ message: "Valid peerId is required" });
      filter.$or = [
        { senderId: req.user.id, receiverId: otherOid },
        { senderId: otherOid, receiverId: req.user.id },
      ];
    } else {
      const uid = new mongoose.Types.ObjectId(req.user.id);
      const groups = await Group.find({ members: req.user.id }).select("_id");
      const organizations = await OrganizationChannel.find({ "members.userId": req.user.id }).select("_id");
      filter.$or = [
        { senderId: uid },
        { receiverId: uid },
        { channel: "announcement" },
        { groupId: { $in: groups.map((g) => g._id) } },
        {
          $and: [
            {
              channel: "organization",
              organizationId: { $in: organizations.map((organization) => organization._id) },
            },
            {
              $or: [
                { senderId: uid },
                { organizationMessageType: "announcement" },
                {
                  organizationMessageType: null,
                  content: { $not: /^Ticket (pending|Number:)/ },
                },
              ],
            },
          ],
        },
      ];
    }

    const items = await Message.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("senderId", "name email avatarUrl")
      .populate("receiverId", "name email avatarUrl")
      .populate("groupId", "name avatarUrl members")
      .populate("organizationId", "name avatarUrl members subjects")
      .lean();

    res.json({ items: items.map(serializeMessage), query: { q, hasFiles } });
  } catch (err) {
    next(err);
  }
};

exports.getModerationMessages = async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const channel = typeof req.query.channel === "string" ? req.query.channel : "";
    const senderOid = toObjectIdOrNull(req.query.senderId);
    const dateFrom = req.query.dateFrom ? new Date(req.query.dateFrom) : null;
    const dateTo = req.query.dateTo ? new Date(req.query.dateTo) : null;
    const includeDeleted = req.query.includeDeleted === "true";
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 120, 1), 300);

    const filter = includeDeleted ? {} : { deleted: { $ne: true } };
    if (q) {
      filter.content = {
        $regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        $options: "i",
      };
    }
    if (["direct", "group", "announcement"].includes(channel)) {
      filter.channel = channel;
    }
    if (senderOid) filter.senderId = senderOid;

    if (
      (dateFrom && !Number.isNaN(dateFrom.getTime())) ||
      (dateTo && !Number.isNaN(dateTo.getTime()))
    ) {
      filter.createdAt = {};
      if (dateFrom && !Number.isNaN(dateFrom.getTime())) {
        filter.createdAt.$gte = dateFrom;
      }
      if (dateTo && !Number.isNaN(dateTo.getTime())) {
        const end = new Date(dateTo);
        end.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = end;
      }
    }

    const items = await Message.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("senderId", "name email avatarUrl suspended")
      .populate("receiverId", "name email avatarUrl suspended")
      .populate("groupId", "name avatarUrl members")
      .populate("moderatedBy", "name email")
      .lean();

    res.json({ items: items.map(serializeMessage), query: { q, channel } });
  } catch (err) {
    next(err);
  }
};

exports.moderateMessage = async (req, res, next) => {
  try {
    const messageId = toObjectIdOrNull(req.params.id);
    if (!messageId) return res.status(400).json({ message: "Valid message id is required" });

    const reason =
      typeof req.body?.reason === "string"
        ? req.body.reason.trim().slice(0, 300)
        : "";
    const message = await Message.findById(messageId);
    if (!message) return res.status(404).json({ message: "Message not found" });

    message.deleted = true;
    message.content = "Message removed by admin";
    message.attachments = [];
    message.moderated = true;
    message.moderatedAt = new Date();
    message.moderatedBy = req.user.id;
    message.moderationReason = reason;
    await message.save();

    const populated = await findMessageWithPeers(message._id);
    const payload = serializeMessage(populated);
    const io = req.app.get("io");
    if (io) emitMessageUpdate(io, populated, payload, "message:updated");

    await recordAudit(req, {
      action: "message.moderated",
      targetType: "message",
      targetId: message._id,
      targetName: message.channel,
      details: { reason, channel: message.channel },
    });

    res.json(payload);
  } catch (err) {
    next(err);
  }
};

exports.sendGroupMessage = async (req, res, next) => {
  try {
    const raw = req.body || {};
    const { groupId } = req.params;
    const group = await findGroupForMember(groupId, req.user.id);

    if (!group) {
      return res.status(404).json({ message: "Group not found" });
    }

    const replyTo = raw.replyTo;
    const subject = optionalPlainString(raw.subject);
    const clientId = optionalPlainString(raw.clientId);
    const content = asMessageContent(raw.content);
    const sanitized = sanitizeAttachments(raw.attachments);
    const hasAttachments = sanitized.length > 0;

    if (!content.trim() && !hasAttachments) {
      return res.status(400).json({
        message: "Message body or attachment required",
      });
    }

    const message = await messageService.createMessage({
      senderId: req.user.id,
      receiverId: null,
      groupId: group._id,
      channel: "group",
      subject,
      content,
      attachments: sanitized,
      replyTo: toObjectIdOrNull(replyTo),
    });

    group.lastMessageAt = new Date();
    await group.save();

    const payload = {
      ...serializeMessage(message),
      ...(clientId ? { clientId } : {}),
    };

    await recordAudit(req, {
      action: "group.message_sent",
      targetType: "message",
      targetId: message._id,
      targetName: subject,
      details: {
        hasAttachments,
        recipientCount: Array.isArray(group.members) ? group.members.length : 0,
      },
    });

    const io = req.app.get("io");
    if (io) {
      group.members.forEach((memberId) => {
        io.to(String(memberId)).emit("message:new", payload);
      });
    }

    res.status(201).json(payload);
  } catch (err) {
    next(err);
  }
};

exports.getGroupMessages = async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const group = await findGroupForMember(groupId, req.user.id);

    if (!group) {
      return res.status(404).json({ message: "Group not found" });
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 40, 1), 100);
    const before = typeof req.query.before === "string" && req.query.before.trim()
      ? req.query.before.trim()
      : undefined;
    const state = await chatStateFor(req.user.id, groupThreadIdFor(group._id));

    const { items, hasMore } = await messageService.getGroupPage({
      groupId: group._id,
      before,
      limit,
      after: state?.deletedAt || null,
    });

    const nextOlderCursor =
      hasMore && items.length ? String(items[0]._id) : null;

    res.json({
      items,
      pagination: {
        limit,
        hasMore,
        nextOlderCursor,
        mode: "cursor",
      },
    });
  } catch (err) {
    next(err);
  }
};

exports.sendAnnouncement = async (req, res, next) => {
  try {
    if (!hasAnyRole(req.user, ANNOUNCEMENT_ROLES)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const raw = req.body || {};
    const subject = optionalPlainString(raw.subject) || "Announcement";
    const content = asMessageContent(raw.content);
    const clientId = optionalPlainString(raw.clientId);
    const sanitized = sanitizeAttachments(raw.attachments);
    const hasAttachments = sanitized.length > 0;

    if (!content.trim() && !hasAttachments) {
      return res.status(400).json({
        message: "Announcement body or attachment required",
      });
    }

    const message = await messageService.createMessage({
      senderId: req.user.id,
      receiverId: null,
      channel: "announcement",
      subject,
      content,
      attachments: sanitized,
      replyTo: null,
    });

    const preview = content.trim() ? content : hasAttachments ? "Attachment" : "";
    const users = await User.find({ _id: { $ne: req.user.id } }).select("_id");
    if (users.length) {
      await Notification.insertMany(
        users.map((user) => ({
          userId: user._id,
          type: "announcement",
          title: subject.trim() || "Announcement",
          body: preview,
        }))
      );
    }

    const payload = {
      ...serializeMessage(message),
      ...(clientId ? { clientId } : {}),
    };

    const io = req.app.get("io");
    if (io) io.emit("message:new", payload);

    res.status(201).json(payload);
  } catch (err) {
    next(err);
  }
};

exports.getAnnouncements = async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 40, 1), 100);
    const before = typeof req.query.before === "string" && req.query.before.trim()
      ? req.query.before.trim()
      : undefined;

    const { items, hasMore } = await messageService.getAnnouncementPage({
      before,
      limit,
    });

    const nextOlderCursor =
      hasMore && items.length ? String(items[0]._id) : null;

    res.json({
      items,
      pagination: {
        limit,
        hasMore,
        nextOlderCursor,
        mode: "cursor",
      },
    });
  } catch (err) {
    next(err);
  }
};

exports.getFlaggedMessages = async (req, res, next) => {
  try {
    const type = req.query.type === "starred" ? "starred" : "pinned";
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 300);
    const peerId = req.query.peerId;
    const groupId = req.query.groupId;
    const organizationId = req.query.organizationId;
    const channel = req.query.channel;

    let filter = { deleted: { $ne: true } };

    if (type === "starred") {
      filter.starredBy = req.user.id;
    } else {
      filter["pinnedBy.0"] = { $exists: true };
    }

    if (channel === "announcement") {
      filter.channel = "announcement";
    } else if (groupId) {
      const group = await findGroupForMember(groupId, req.user.id);
      if (!group) {
        return res.status(404).json({ message: "Group not found" });
      }
      filter.channel = "group";
      filter.groupId = group._id;
    } else if (organizationId) {
      const organization = await findOrganizationForMember(organizationId, req.user.id);
      if (!organization) {
        return res.status(404).json({ message: "Organization channel not found" });
      }
      filter.channel = "organization";
      filter.organizationId = organization._id;
      filter.$or = [
        { senderId: req.user.id },
        { organizationMessageType: "announcement" },
        {
          organizationMessageType: null,
          content: { $not: /^Ticket (pending|Number:)/ },
        },
      ];
    } else {
      const otherOid = toObjectIdOrNull(peerId);
      if (!otherOid) {
        return res.status(400).json({ message: "Valid peerId is required" });
      }
      filter.$and = [
        {
          $or: [
            { channel: "direct" },
            { channel: { $exists: false } },
            { channel: null },
          ],
        },
        {
          $or: [
            { senderId: req.user.id, receiverId: otherOid },
            { senderId: otherOid, receiverId: req.user.id },
          ],
        },
      ];
    }

    const messages = await Message.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .populate("replyTo")
      .populate("senderId", "name email avatarUrl")
      .populate("receiverId", "name email avatarUrl")
      .populate("seenBy.userId", "name email avatarUrl")
      .populate("groupId", "name avatarUrl members")
      .populate("organizationId", "name avatarUrl members subjects");

    res.json({ items: messages.map(serializeMessage) });
  } catch (err) {
    next(err);
  }
};

exports.getAllStarredMessages = async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 300);
    const uid = new mongoose.Types.ObjectId(req.user.id);
    const groups = await Group.find({ members: req.user.id }).select("_id").lean();

    const messages = await Message.find({
      deleted: { $ne: true },
      starredBy: req.user.id,
      $or: [
        {
          $and: [
            {
              $or: [
                { channel: "direct" },
                { channel: { $exists: false } },
                { channel: null },
              ],
            },
            { $or: [{ senderId: uid }, { receiverId: uid }] },
          ],
        },
        {
          channel: "group",
          groupId: { $in: groups.map((group) => group._id) },
        },
      ],
    })
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .populate("replyTo")
      .populate("senderId", "name email avatarUrl")
      .populate("receiverId", "name email avatarUrl")
      .populate("seenBy.userId", "name email avatarUrl")
      .populate("groupId", "name avatarUrl members");

    res.json({ items: messages.map(serializeMessage) });
  } catch (err) {
    next(err);
  }
};

exports.getChatStates = async (req, res, next) => {
  try {
    const rows = await ChatState.find({ userId: req.user.id }).lean();
    res.json({
      items: rows.map((row) => ({
        threadId: row.threadId,
        archived: Boolean(row.archived),
        deletedAt: row.deletedAt || null,
        updatedAt: row.updatedAt,
      })),
    });
  } catch (err) {
    next(err);
  }
};

exports.updateChatState = async (req, res, next) => {
  try {
    const threadId = typeof req.body?.threadId === "string" ? req.body.threadId.trim() : "";
    const action = typeof req.body?.action === "string" ? req.body.action.trim() : "";
    if (!threadId) return res.status(400).json({ message: "threadId is required" });

    const isGroupThread = threadId.startsWith(GROUP_THREAD_PREFIX);
    if (isGroupThread) {
      const group = await findGroupForMember(threadId.slice(GROUP_THREAD_PREFIX.length), req.user.id);
      if (!group) return res.status(404).json({ message: "Group not found" });
    } else if (threadId === "announcement" || threadId.startsWith("org:")) {
      return res.status(400).json({ message: "This chat cannot be archived or deleted" });
    } else {
      const parts = threadId.split(":").filter(Boolean);
      if (parts.length !== 2 || !parts.includes(String(req.user.id))) {
        return res.status(400).json({ message: "Invalid direct chat" });
      }
    }

    const patch = {};
    if (action === "archive") {
      patch.archived = true;
    } else if (action === "unarchive") {
      patch.archived = false;
    } else if (action === "delete") {
      patch.archived = false;
      patch.deletedAt = new Date();
    } else {
      return res.status(400).json({ message: "Valid action is required" });
    }

    const state = await ChatState.findOneAndUpdate(
      { userId: req.user.id, threadId },
      { $set: patch },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();

    res.json({
      threadId: state.threadId,
      archived: Boolean(state.archived),
      deletedAt: state.deletedAt || null,
      updatedAt: state.updatedAt,
    });
  } catch (err) {
    next(err);
  }
};

exports.getChatAttachments = async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 1000);
    const peerId = req.query.peerId;
    const groupId = req.query.groupId;
    const scope = req.query.scope;
    const channel = req.query.channel;

    let filter = {
      "attachments.0": { $exists: true },
      deleted: { $ne: true },
    };

    if (scope === "all") {
      const groups = await Group.find({ members: req.user.id }).select("_id").lean();
      const organizations = await OrganizationChannel.find({ "members.userId": req.user.id }).select("_id").lean();
      filter.$or = [
        { channel: "announcement" },
        {
          $and: [
            {
              $or: [
                { channel: "direct" },
                { channel: { $exists: false } },
                { channel: null },
              ],
            },
            {
              $or: [{ senderId: req.user.id }, { receiverId: req.user.id }],
            },
          ],
        },
        {
          channel: "group",
          groupId: { $in: groups.map((group) => group._id) },
        },
        {
          channel: "organization",
          organizationId: { $in: organizations.map((organization) => organization._id) },
          $or: [
            { senderId: req.user.id },
            { organizationMessageType: "announcement" },
            {
              organizationMessageType: null,
              content: { $not: /^Ticket (pending|Number:)/ },
            },
          ],
        },
      ];
    } else if (channel === "announcement") {
      filter.channel = "announcement";
    } else if (groupId) {
      const group = await findGroupForMember(groupId, req.user.id);
      if (!group) {
        return res.status(404).json({ message: "Group not found" });
      }
      filter.channel = "group";
      filter.groupId = group._id;
    } else {
      const otherOid = toObjectIdOrNull(peerId);
      if (!otherOid) {
        return res.status(400).json({ message: "Valid peerId is required" });
      }
      filter.$and = [
        {
          $or: [
            { channel: "direct" },
            { channel: { $exists: false } },
            { channel: null },
          ],
        },
        {
          $or: [
            { senderId: req.user.id, receiverId: otherOid },
            { senderId: otherOid, receiverId: req.user.id },
          ],
        },
      ];
    }

    const messages = await Message.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .populate("senderId", "name email avatarUrl")
      .populate("receiverId", "name email avatarUrl")
      .populate("groupId", "name avatarUrl")
      .populate("organizationId", "name avatarUrl")
      .lean();

    const items = [];
    for (const message of messages) {
      for (const file of message.attachments || []) {
        items.push({
          ...file,
          messageId: idFromRef(message._id),
          messageCreatedAt: message.createdAt,
          senderId: message.senderId,
          receiverId: message.receiverId || null,
          groupId: message.groupId || null,
          organizationId: message.organizationId || null,
          channel: message.channel || "direct",
          chatName:
            message.channel === "announcement"
              ? "Announcement"
              : message.channel === "group"
                ? message.groupId?.name || "Group chat"
                : message.channel === "organization"
                  ? message.organizationId?.name || "Organization channel"
                  : idFromRef(message.senderId) === String(req.user.id)
                    ? message.receiverId?.name || message.receiverId?.email || "Direct chat"
                    : message.senderId?.name || message.senderId?.email || "Direct chat",
          senderName: message.senderId?.name || message.senderId?.email || "",
        });
      }
    }

    items.sort((a, b) => {
      const aTime = new Date(a.messageCreatedAt || 0).getTime();
      const bTime = new Date(b.messageCreatedAt || 0).getTime();
      return bTime - aTime;
    });

    res.json({ items });
  } catch (err) {
    next(err);
  }
};

/* =========================
   GET MESSAGES (OPTIONAL IMPROVED)
========================= */
exports.getMessages = async (req, res, next) => {
  try {
    const { userId, receiverId } = req.query;

    const messages = await Message.find({
      $or: [
        { senderId: userId, receiverId },
        { senderId: receiverId, receiverId: userId }
      ]
    })
      .sort({ createdAt: 1 })
      .populate("replyTo"); // 👈 enables thread preview

    res.json(messages);
  } catch (err) {
    next(err);
  }
};
