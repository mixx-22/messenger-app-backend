require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const User = require("./models/User");
const Message = require("./models/Message");
const Group = require("./models/Group");

const app = express();
const uploadDir = path.resolve(process.env.UPLOAD_DIR || "uploads");
const gifDir = process.env.GIFS_DIR ? path.resolve(process.env.GIFS_DIR) : "";
const allowedOrigins = String(process.env.CORS_ORIGIN || "*")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function allowOrigin(origin, callback) {
  if (!origin || allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
    return callback(null, true);
  }
  return callback(new Error("Not allowed by CORS"));
}

/* =========================
   MIDDLEWARE
========================= */
app.use(cors({ origin: allowOrigin }));
app.use(express.json());
app.use("/uploads", express.static(uploadDir));
if (gifDir) {
  app.use("/gifs", express.static(gifDir));
}
app.set("uploadDir", uploadDir);

/* =========================
   ROUTES
========================= */
app.use("/api/auth", require("./routes/authRoutes"));
app.use("/api/users", require("./routes/userRoutes"));
app.use("/api/settings", require("./routes/settingsRoutes"));
app.use("/api/groups", require("./routes/groupRoutes"));
app.use("/api/organizations", require("./routes/organizationRoutes"));
app.use("/api/messages", require("./routes/messageRoutes"));
app.use("/api/upload", require("./routes/uploadRoutes"));
app.use("/api/gifs", require("./routes/gifRoutes"));
app.use("/api/audit", require("./routes/auditRoutes"));

const appSettingService = require("./services/appSettingService");

/* =========================
   HTTP SERVER + SOCKET.IO
========================= */
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: allowedOrigins.includes("*") ? "*" : allowedOrigins,
    methods: ["GET", "POST", "DELETE", "PUT"],
  },
});

/* 🔥 IMPORTANT: allow controllers to access io */
app.set("io", io);

/* =========================
   SOCKET STATE
========================= */
const onlineUsers = new Map();

function idFromRef(ref) {
  if (ref == null) return "";
  if (typeof ref === "object") return String(ref._id || ref.id || "");
  return String(ref);
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
    replyTo: raw.replyTo || null,
    attachments: Array.isArray(raw.attachments) ? raw.attachments : [],
    reactions: Array.isArray(raw.reactions) ? raw.reactions : [],
    seenBy: Array.isArray(raw.seenBy) ? raw.seenBy : [],
  };
}

function addOnlineSocket(userId, socketId) {
  const uid = String(userId);
  const sockets = onlineUsers.get(uid) || new Set();
  sockets.add(socketId);
  onlineUsers.set(uid, sockets);
}

function removeOnlineSocket(userId, socketId) {
  const uid = String(userId);
  const sockets = onlineUsers.get(uid);
  if (!sockets) return false;
  sockets.delete(socketId);
  if (sockets.size > 0) return false;
  onlineUsers.delete(uid);
  return true;
}

io.use(async (socket, next) => {
  try {
    const token =
      socket.handshake.auth?.token ||
      String(socket.handshake.headers?.authorization || "").replace(
        /^Bearer\s+/i,
        ""
      );

    if (!token) return next(new Error("Authentication required"));

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select("_id role roles name email suspended");

    if (!user) return next(new Error("Invalid user"));
    if (user.suspended) return next(new Error("Account suspended"));

    const roles = Array.isArray(user.roles) && user.roles.length
      ? user.roles
      : [user.role || "User"];
    socket.user = {
      id: String(user._id),
      role: user.role,
      roles,
      name: user.name,
      email: user.email,
    };

    next();
  } catch {
    next(new Error("Invalid token"));
  }
});

/* =========================
   SOCKET EVENTS
========================= */
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);
  socket.userId = socket.user.id;
  socket.join(socket.userId);
  addOnlineSocket(socket.userId, socket.id);

  socket.emit("presence_snapshot", {
    onlineUserIds: Array.from(onlineUsers.keys()).map(String),
  });

  io.emit("user_online", { userId: socket.userId });

  /* -------------------------
     JOIN USER ROOM
  ------------------------- */
  socket.on("join", () => {
    socket.join(socket.userId);
    socket.emit("presence_snapshot", {
      onlineUserIds: Array.from(onlineUsers.keys()).map(String),
    });
  });

  /* -------------------------
     TYPING INDICATOR
  ------------------------- */
  socket.on("typing", ({ receiverId }) => {
    const rid = receiverId != null ? String(receiverId) : "";
    if (!rid) return;
    if (rid.startsWith("group:")) {
      const groupId = rid.slice("group:".length);
      Group.findOne({ _id: groupId, members: socket.userId })
        .select("members")
        .then((group) => {
          if (!group) return;
          group.members.forEach((memberId) => {
            if (String(memberId) !== socket.userId) {
              io.to(String(memberId)).emit("typing", { senderId: socket.userId });
            }
          });
        })
        .catch(() => {});
      return;
    }
    io.to(rid).emit("typing", { senderId: socket.userId });
  });

  socket.on("stop_typing", ({ receiverId }) => {
    const rid = receiverId != null ? String(receiverId) : "";
    if (!rid) return;
    if (rid.startsWith("group:")) {
      const groupId = rid.slice("group:".length);
      Group.findOne({ _id: groupId, members: socket.userId })
        .select("members")
        .then((group) => {
          if (!group) return;
          group.members.forEach((memberId) => {
            if (String(memberId) !== socket.userId) {
              io.to(String(memberId)).emit("stop_typing", { senderId: socket.userId });
            }
          });
        })
        .catch(() => {});
      return;
    }
    io.to(rid).emit("stop_typing", { senderId: socket.userId });
  });

  /* -------------------------
     MESSAGE PUSH (CLIENT EMIT)
     Frontend emits `send_message` after saving via REST.
     Rebroadcast so receivers update instantly even if they don't refetch.
  ------------------------- */
  socket.on("send_message", async ({ receiverId, message } = {}) => {
    try {
      const rid = receiverId != null ? String(receiverId) : "";
      const messageId =
        message && typeof message === "object" && message._id
          ? String(message._id)
          : "";
      if (!rid || !messageId) return;

      const saved = await Message.findById(messageId)
        .populate("replyTo")
        .populate("senderId", "name email avatarUrl")
        .populate("receiverId", "name email avatarUrl");

      const senderRoom = idFromRef(saved?.senderId);
      const receiverRoom = idFromRef(saved?.receiverId);
      if (
        !saved ||
        senderRoom !== socket.userId ||
        receiverRoom !== rid
      ) {
        return;
      }

      const payload = serializeMessage(saved);
      io.to(receiverRoom).emit("message:new", payload);
      io.to(senderRoom).emit("message:new", payload);
    } catch (e) {
      console.error("send_message handler:", e);
    }
  });

  /* -------------------------
     READ RECEIPTS
  ------------------------- */
  socket.on("message_seen", async ({ messageId }) => {
    try {
      const Message = require("./models/Message");

      const message = await Message.findById(messageId)
        .populate("senderId", "name email avatarUrl")
        .populate("receiverId", "name email avatarUrl")
        .populate("groupId", "name avatarUrl members")
        .populate("organizationId", "name avatarUrl members")
        .populate("seenBy.userId", "name email avatarUrl");

      if (!message || !socket.userId) return;

      const currentUserId = String(socket.userId);
      const alreadySeen = (message.seenBy || []).some(
        (row) => idFromRef(row.userId) === currentUserId
      );

      if (!alreadySeen) {
        message.seenBy.push({ userId: socket.userId, seenAt: new Date() });
      }

      if (idFromRef(message.receiverId) === currentUserId) {
        message.isRead = true;
        message.readAt = new Date();
      }

      await message.save();
      await message.populate("seenBy.userId", "name email avatarUrl");

      const payload = serializeMessage(message);

      if (payload.channel === "announcement") {
        io.emit("message_seen_update", payload);
      } else if (payload.channel === "group") {
        const members = Array.isArray(message.groupId?.members)
          ? message.groupId.members
          : [];
        members.forEach((memberId) => {
          io.to(String(memberId)).emit("message_seen_update", payload);
        });
      } else if (payload.channel === "organization") {
        const members = Array.isArray(message.organizationId?.members)
          ? message.organizationId.members
          : [];
        members.forEach((member) => {
          const memberId = idFromRef(member?.userId || member);
          if (memberId) io.to(String(memberId)).emit("message_seen_update", payload);
        });
      } else {
        const senderRoom = idFromRef(message.senderId);
        const receiverRoom = idFromRef(message.receiverId);
        if (senderRoom) io.to(senderRoom).emit("message_seen_update", payload);
        if (receiverRoom) io.to(receiverRoom).emit("message_seen_update", payload);
      }
    } catch (err) {
      console.error(err);
    }
  });

  /* -------------------------
     DISCONNECT
  ------------------------- */
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);

    if (socket.userId) {
      const wentOffline = removeOnlineSocket(socket.userId, socket.id);
      if (!wentOffline) return;
      io.emit("user_offline", {
        userId: socket.userId,
        lastSeen: new Date(),
      });
    }
  });
});

/* =========================
   GLOBAL ERROR HANDLER
========================= */
app.use((err, req, res, next) => {
  if (process.env.NODE_ENV !== "production") {
    console.error(err);
  }

  const validationLike =
    err.name === "ValidationError" ||
    err.name === "CastError" ||
    err.name === "BSONError";

  const status =
    err.statusCode && Number.isFinite(err.statusCode)
      ? err.statusCode
      : validationLike
      ? 400
      : 500;

  res.status(status).json({
    message:
      process.env.NODE_ENV === "production" && status >= 500
        ? "Internal Server Error"
        : err.message || "Internal Server Error",
  });
});

/* =========================
   DATABASE + SERVER START
========================= */
const DEFAULT_PORT = 4000;
const START_PORT = Number.parseInt(process.env.PORT, 10) || DEFAULT_PORT;
const MAX_PORT_RETRIES = 10;

function startServerWithFallback(port, retriesLeft) {
  const onListening = () => {
    const bound = server.address();
    const boundPort = typeof bound === "object" && bound ? bound.port : port;

    if (boundPort !== START_PORT) {
      console.warn(
        `[startup] Port ${START_PORT} busy. Fallback to ${boundPort}.`
      );
    }

    const hostLabel =
      typeof bound === "object" && bound && bound.address
        ? bound.address
        : "0.0.0.0";

    console.log(`Server listening on http://${hostLabel}:${boundPort}`);
  };

  const onError = (err) => {
    if (err.code === "EADDRINUSE" && retriesLeft > 0) {
      const nextPort = port + 1;
      console.warn(
        `[startup] Port ${port} in use. Retrying on ${nextPort}`
      );
      return startServerWithFallback(nextPort, retriesLeft - 1);
    }

    console.error("[startup] Server failed:", err);
    process.exit(1);
  };

  server.once("listening", onListening);
  server.once("error", onError);

  const host = process.env.HOST || "0.0.0.0";
  server.listen(port, host);
}

/* =========================
   STARTUP
========================= */
mongoose
  .connect(process.env.MONGO_URI)
  .then(async () => {
    console.log("MongoDB Connected");

    try {
      await appSettingService.ensureGlobalSettings();
    } catch (e) {
      console.error("[startup] App settings init failed:", e);
    }

    startServerWithFallback(START_PORT, MAX_PORT_RETRIES);
  })
  .catch((err) => {
    console.error("MongoDB Connection Error:", err);
  });
