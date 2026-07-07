import { Server as HttpServer } from "http";
import { Server, Socket } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import jwt from "jsonwebtoken";
import { Types } from "mongoose";
import config from "../config";
import { getRedisClient } from "./redis.util";
import ChatMessage from "../models/chat-message.model";

interface AuthenticatedSocket extends Socket {
  userId?: string;
  userType?: "USER" | "DRIVER" | "ADMIN";
}

let io: Server | null = null;

/**
 * Initialize Socket.io with Redis adapter for scaling
 */
export const initSocket = async (httpServer: HttpServer): Promise<Server> => {
  io = new Server(httpServer, {
    cors: {
      origin: config.cors.origin || "*",
      methods: ["GET", "POST"],
      credentials: true,
    },
    pingInterval: 25000,
    pingTimeout: 5000,
    transports: ["websocket", "polling"],
  });

  // Use Redis adapter for horizontal scaling
  try {
    const redisClient = getRedisClient();
    const pubClient = redisClient.duplicate();
    const subClient = redisClient.duplicate();
    await Promise.all([pubClient.connect(), subClient.connect()]);
    io.adapter(createAdapter(pubClient, subClient));
    console.log("Socket.io: Redis adapter initialized");
  } catch (error) {
    console.warn(
      "Socket.io: Running without Redis adapter (single instance mode)",
    );
  }

  // Authentication middleware
  io.use((socket: AuthenticatedSocket, next) => {
    const token = socket.handshake.auth.token || socket.handshake.query.token;

    if (!token) {
      return next(new Error("Authentication required"));
    }

    try {
      const decoded = jwt.verify(token, config.jwt.secret) as any;
      // Driver tokens are signed as { driverId } and carry NO userType; user
      // tokens use _id/userId. Previously this only read _id/userId, so a driver
      // socket got userId=undefined and userType="USER" — which made the
      // chat:message handler bail on `!socket.userId` (driver messages never
      // saved) and location/status handlers bail on `userType !== "DRIVER"`.
      // Detect the driver token by its driverId field.
      if (decoded.driverId) {
        socket.userId = decoded.driverId;
        socket.userType = "DRIVER";
      } else {
        socket.userId = decoded._id || decoded.userId;
        socket.userType = decoded.userType || "USER";
      }
      next();
    } catch (error) {
      next(new Error("Invalid token"));
    }
  });

  // Connection handler
  io.on("connection", (socket: AuthenticatedSocket) => {
    console.log(`Socket connected: ${socket.userId} (${socket.userType})`);

    // Join user-specific room
    if (socket.userId) {
      socket.join(`user:${socket.userId}`);

      if (socket.userType === "DRIVER") {
        socket.join("drivers");

        // Self-heal the Redis geo-set. Every disconnect (e.g. a backend
        // restart) zRems the driver, and a stationary phone may not send a
        // location ping for a long time — during that gap the driver is
        // invisible to dispatch. Restore their last known location from Mongo
        // whenever any of their sockets (re)connects and they're online.
        (async () => {
          try {
            const DriverLocation = (
              await import("../models/driver-location.model")
            ).default;
            const Driver = (await import("../models/driver.model")).default;
            const [loc, drv] = await Promise.all([
              DriverLocation.findOne({ driverId: socket.userId }).select(
                "longitude latitude",
              ),
              Driver.findById(socket.userId).select("isOnline status"),
            ]);
            if (loc && drv?.isOnline && drv?.status === "approved") {
              const redis = getRedisClient();
              await redis.geoAdd("driver:locations", {
                longitude: loc.longitude,
                latitude: loc.latitude,
                member: String(socket.userId),
              });
            }
          } catch (e: any) {
            console.error("geo-set self-heal failed:", e?.message);
          }
        })();
      }
    }

    // Handle driver location updates
    socket.on("driver:location:update", async (data) => {
      if (socket.userType !== "DRIVER" || !socket.userId) return;

      const { lat, lng, heading, speed } = data;

      // Cache driver location in Redis
      const locationData = {
        driverId: socket.userId,
        lat,
        lng,
        heading,
        speed,
        timestamp: Date.now(),
      };

      try {
        const redis = getRedisClient();
        await redis.setEx(
          `driver:location:${socket.userId}`,
          30, // 30 second TTL
          JSON.stringify(locationData),
        );

        // Add to geospatial index for nearby driver queries
        await redis.geoAdd("driver:locations", {
          longitude: lng,
          latitude: lat,
          member: socket.userId,
        });
      } catch (error) {
        console.error("Error updating driver location:", error);
      }

      // Also persist to Mongo DriverLocation — the user home map
      // (/tracking/nearby-drivers) and the admin live map read from this
      // collection, but previously only Redis was written, so both maps were
      // permanently empty. Fire-and-forget so it never delays the socket loop.
      try {
        const DriverLocation = (
          await import("../models/driver-location.model")
        ).default;
        DriverLocation.findOneAndUpdate(
          { driverId: socket.userId },
          {
            driverId: socket.userId,
            location: { type: "Point", coordinates: [lng, lat] },
            latitude: lat,
            longitude: lng,
            heading: heading || 0,
            speed: speed || 0,
            isOnline: true,
            lastUpdated: new Date(),
          },
          { upsert: true },
        ).catch((e: any) =>
          console.error("DriverLocation upsert failed:", e?.message),
        );
      } catch (error) {
        console.error("Error persisting driver location:", error);
      }

      // Emit to tracking users (those tracking this driver's booking)
      socket
        .to(`tracking:driver:${socket.userId}`)
        .emit("driver:location", locationData);
    });

    // Handle driver going online/offline
    socket.on("driver:status", async (data) => {
      if (socket.userType !== "DRIVER" || !socket.userId) return;

      const { isOnline } = data;

      if (isOnline) {
        socket.join("drivers:online");
      } else {
        socket.leave("drivers:online");
        // Remove from geospatial index
        try {
          const redis = getRedisClient();
          await redis.zRem("driver:locations", socket.userId);
        } catch (error) {
          console.error("Error removing driver location:", error);
        }
        // Mirror offline state to Mongo so nearby/map queries drop the driver.
        try {
          const DriverLocation = (
            await import("../models/driver-location.model")
          ).default;
          DriverLocation.updateOne(
            { driverId: socket.userId },
            { isOnline: false },
          ).catch(() => {});
        } catch {
          /* non-fatal */
        }
      }
    });

    // User starts tracking a booking
    socket.on("booking:track:start", (data) => {
      const { bookingId, driverId } = data;
      if (bookingId) socket.join(`booking:${bookingId}`);
      if (driverId) socket.join(`tracking:driver:${driverId}`);
    });

    // User stops tracking
    socket.on("booking:track:stop", (data) => {
      const { bookingId, driverId } = data;
      if (bookingId) socket.leave(`booking:${bookingId}`);
      if (driverId) socket.leave(`tracking:driver:${driverId}`);
    });

    // Handle chat messages — persist to DB and broadcast
    socket.on("chat:message", async (data) => {
      const { bookingId, message, messageType, imageUrl } = data;

      if (!bookingId || !socket.userId) return;

      try {
        // Save to database
        const chatMsg = await ChatMessage.create({
          bookingId: new Types.ObjectId(bookingId),
          senderId: new Types.ObjectId(socket.userId),
          senderType: socket.userType === "DRIVER" ? "DRIVER" : "USER",
          messageType: messageType || "TEXT",
          message: message || "",
          imageUrl: imageUrl || undefined,
        });

        const payload = {
          _id: chatMsg._id,
          bookingId,
          senderId: socket.userId,
          senderType: chatMsg.senderType,
          message: chatMsg.message,
          messageType: chatMsg.messageType,
          imageUrl: chatMsg.imageUrl,
          createdAt: chatMsg.createdAt.toISOString(),
        };

        // Broadcast to everyone in the booking room (including sender for confirmation)
        io!.to(`booking:${bookingId}`).emit("chat:message", payload);
      } catch (error) {
        console.error("Error saving chat message:", error);
        socket.emit("chat:error", { message: "Failed to send message" });
      }
    });

    // Join chat room
    socket.on("chat:join", (data) => {
      const { bookingId } = data;
      if (bookingId) {
        socket.join(`booking:${bookingId}`);
        console.log(`${socket.userId} joined chat:booking:${bookingId}`);
      }
    });

    // Leave chat room
    socket.on("chat:leave", (data) => {
      const { bookingId } = data;
      if (bookingId) socket.leave(`booking:${bookingId}`);
    });

    // Mark messages as read
    socket.on("chat:read", async (data) => {
      const { bookingId } = data;
      if (!bookingId || !socket.userId) return;

      try {
        await ChatMessage.updateMany(
          {
            bookingId: new Types.ObjectId(bookingId),
            senderId: { $ne: new Types.ObjectId(socket.userId) },
            isRead: false,
          },
          { isRead: true }
        );
      } catch (error) {
        console.error("Error marking messages read:", error);
      }
    });

    // Disconnect handler
    socket.on("disconnect", async () => {
      console.log(`Socket disconnected: ${socket.userId}`);

      // If driver, remove from online drivers
      if (socket.userType === "DRIVER" && socket.userId) {
        try {
          const redis = getRedisClient();
          await redis.zRem("driver:locations", socket.userId);
        } catch (error) {
          console.error("Error removing driver on disconnect:", error);
        }
      }
    });
  });

  return io;
};

/**
 * Get Socket.io instance
 */
export const getIO = (): Server => {
  if (!io) {
    throw new Error("Socket.io not initialized");
  }
  return io;
};

/**
 * Emit to specific user
 */
export const emitToUser = (userId: string, event: string, data: any): void => {
  if (io) {
    io.to(`user:${userId}`).emit(event, data);
  }
};

/**
 * Emit to booking room
 */
export const emitToBooking = (
  bookingId: string,
  event: string,
  data: any,
): void => {
  if (io) {
    io.to(`booking:${bookingId}`).emit(event, data);
  }
};

/**
 * Emit to nearby drivers
 */
export const emitToNearbyDrivers = async (
  location: { lat: number; lng: number },
  radiusKm: number,
  event: string,
  data: any,
): Promise<void> => {
  try {
    const redis = getRedisClient();

    // Find drivers within radius
    const nearbyDrivers = await redis.geoSearch(
      "driver:locations",
      { longitude: location.lng, latitude: location.lat },
      { radius: radiusKm, unit: "km" },
    );

    if (io && nearbyDrivers.length > 0) {
      nearbyDrivers.forEach((driverId) => {
        io!.to(`user:${driverId}`).emit(event, data);
      });
    }
  } catch (error) {
    console.error("Error emitting to nearby drivers:", error);
  }
};

/**
 * Emit booking status update
 */
export const emitBookingUpdate = (
  bookingId: string,
  userId: string,
  driverId: string | null,
  status: string,
  data?: any,
): void => {
  const updateData = {
    bookingId,
    status,
    timestamp: new Date().toISOString(),
    ...data,
  };

  // Emit to booking room
  emitToBooking(bookingId, "booking:status", updateData);

  // Emit to user directly
  emitToUser(userId, "booking:status", updateData);

  // Emit to driver if assigned
  if (driverId) {
    emitToUser(driverId, "booking:status", updateData);
  }
};

export default {
  initSocket,
  getIO,
  emitToUser,
  emitToBooking,
  emitToNearbyDrivers,
  emitBookingUpdate,
};
