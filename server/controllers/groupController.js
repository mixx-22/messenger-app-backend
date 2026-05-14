const Group = require('../models/Group');
const Message = require('../models/Message');

function memberIdsFromBody(value, ownerId) {
  const ids = Array.isArray(value) ? value : [];
  return [...new Set([ownerId, ...ids.map((id) => String(id || '').trim())])]
    .filter((id) => /^[a-fA-F0-9]{24}$/.test(id));
}

async function populatedGroup(id) {
  return Group.findById(id)
    .populate('members', 'name email avatarUrl')
    .populate('createdBy', 'name email avatarUrl');
}

function groupAdminId(group) {
  const admin = group?.createdBy;
  if (!admin) return '';
  if (typeof admin === 'object') return String(admin._id || admin.id || '');
  return String(admin);
}

function requireGroupAdmin(group, userId) {
  return group && groupAdminId(group) === String(userId);
}

async function createSystemMessage(groupId, userId, content) {
  return Message.create({
    senderId: userId,
    groupId,
    receiverId: null,
    channel: 'group',
    content,
    system: true,
  });
}

function emitGroupEvent(req, group, eventName, payload) {
  const io = req.app.get('io');
  if (!io || !group) return;
  const members = group.members || [];
  members.forEach((member) => {
    const id = typeof member === 'object' ? member._id || member.id : member;
    if (id) io.to(String(id)).emit(eventName, payload);
  });
}

exports.listGroups = async (req, res, next) => {
  try {
    const groups = await Group.find({ members: req.user.id })
      .sort({ lastMessageAt: -1, updatedAt: -1 })
      .populate('members', 'name email avatarUrl')
      .populate('createdBy', 'name email avatarUrl')
      .lean();

    const latestRows = await Promise.all(
      groups.map(async (group) => {
        const last = await Message.findOne({
          groupId: group._id,
          channel: 'group',
        })
          .sort({ _id: -1 })
          .select('_id content createdAt attachments')
          .lean();
        return [String(group._id), last || null];
      })
    );

    const latestByGroup = Object.fromEntries(latestRows);

    res.json(
      groups.map((group) => ({
        ...group,
        lastMessage: latestByGroup[String(group._id)],
      }))
    );
  } catch (err) {
    next(err);
  }
};

exports.createGroup = async (req, res, next) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) {
      return res.status(400).json({ message: 'Group name is required' });
    }

    const members = memberIdsFromBody(req.body?.memberIds, req.user.id);
    if (members.length < 2) {
      return res.status(400).json({ message: 'Choose at least one member' });
    }

    const group = await Group.create({
      name,
      members,
      createdBy: req.user.id,
      lastMessageAt: new Date(),
    });

    const populated = await populatedGroup(group._id);

    res.status(201).json(populated);
  } catch (err) {
    next(err);
  }
};

exports.updateGroupMembers = async (req, res, next) => {
  try {
    const group = await Group.findById(req.params.id);
    if (!group || !group.members.map(String).includes(String(req.user.id))) {
      return res.status(404).json({ message: 'Group not found' });
    }

    if (!requireGroupAdmin(group, req.user.id)) {
      return res.status(403).json({ message: 'Only the group admin can manage members' });
    }

    const members = memberIdsFromBody(req.body?.memberIds, req.user.id);
    if (members.length < 2) {
      return res.status(400).json({ message: 'Group must have at least one member besides the admin' });
    }

    const before = group.members.map(String);
    const added = members.filter((id) => !before.includes(String(id)));
    const removed = before.filter((id) => !members.includes(String(id)));

    group.members = members;
    await group.save();

    const updated = await populatedGroup(group._id);
    const io = req.app.get('io');
    if (io) {
      [...new Set([...members, ...before])].forEach((memberId) => {
        io.to(String(memberId)).emit('group:updated', updated);
      });
    }

    if (added.length || removed.length) {
      const parts = [];
      if (added.length) parts.push(`added ${added.length} member${added.length > 1 ? 's' : ''}`);
      if (removed.length) parts.push(`removed ${removed.length} member${removed.length > 1 ? 's' : ''}`);
      const system = await createSystemMessage(group._id, req.user.id, `${req.user.name || 'Admin'} ${parts.join(' and ')}.`);
      emitGroupEvent(req, updated, 'message:new', {
        ...system.toObject(),
        senderId: { _id: req.user.id, name: req.user.name, email: req.user.email },
        groupId: updated,
      });
    }

    res.json(updated);
  } catch (err) {
    next(err);
  }
};

exports.updateGroupDetails = async (req, res, next) => {
  try {
    const group = await Group.findById(req.params.id);
    if (!group || !group.members.map(String).includes(String(req.user.id))) {
      return res.status(404).json({ message: 'Group not found' });
    }

    if (!requireGroupAdmin(group, req.user.id)) {
      return res.status(403).json({ message: 'Only the group admin can edit this group' });
    }

    const oldName = group.name;
    if (typeof req.body?.name === 'string' && req.body.name.trim()) {
      group.name = req.body.name.trim();
    }
    if (typeof req.body?.avatarUrl === 'string') {
      group.avatarUrl = req.body.avatarUrl.trim();
    }

    await group.save();
    const updated = await populatedGroup(group._id);

    if (oldName !== group.name) {
      const system = await createSystemMessage(group._id, req.user.id, `${req.user.name || 'Admin'} renamed the group to ${group.name}.`);
      emitGroupEvent(req, updated, 'message:new', {
        ...system.toObject(),
        senderId: { _id: req.user.id, name: req.user.name, email: req.user.email },
        groupId: updated,
      });
    }

    emitGroupEvent(req, updated, 'group:updated', updated);
    res.json(updated);
  } catch (err) {
    next(err);
  }
};

exports.leaveGroup = async (req, res, next) => {
  try {
    const group = await Group.findById(req.params.id);
    if (!group || !group.members.map(String).includes(String(req.user.id))) {
      return res.status(404).json({ message: 'Group not found' });
    }

    if (requireGroupAdmin(group, req.user.id)) {
      return res.status(400).json({ message: 'Group admin must delete the group or transfer ownership first' });
    }

    const previousMembers = group.members.map(String);
    group.members = previousMembers.filter((id) => id !== String(req.user.id));
    await group.save();
    const updated = await populatedGroup(group._id);
    const system = await createSystemMessage(group._id, req.user.id, `${req.user.name || 'A member'} left the group.`);

    const io = req.app.get('io');
    if (io) {
      previousMembers.forEach((memberId) => {
        io.to(String(memberId)).emit('group:updated', updated);
        io.to(String(memberId)).emit('message:new', {
          ...system.toObject(),
          senderId: { _id: req.user.id, name: req.user.name, email: req.user.email },
          groupId: updated,
        });
      });
    }

    res.json({ success: true, group: updated });
  } catch (err) {
    next(err);
  }
};

exports.deleteGroup = async (req, res, next) => {
  try {
    const group = await Group.findById(req.params.id);
    if (!group || !group.members.map(String).includes(String(req.user.id))) {
      return res.status(404).json({ message: 'Group not found' });
    }

    if (!requireGroupAdmin(group, req.user.id)) {
      return res.status(403).json({ message: 'Only the group admin can delete this group' });
    }

    const memberIds = group.members.map(String);
    await Message.deleteMany({ groupId: group._id });
    await Group.deleteOne({ _id: group._id });

    const io = req.app.get('io');
    if (io) {
      memberIds.forEach((memberId) => {
        io.to(memberId).emit('group:deleted', { id: String(group._id) });
      });
    }

    res.json({ success: true, id: String(group._id) });
  } catch (err) {
    next(err);
  }
};
