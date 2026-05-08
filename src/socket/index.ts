import { Server as SocketServer, Socket } from 'socket.io';
import { Server as HttpServer } from 'http';
import jwt from 'jsonwebtoken';
import { User } from '../models';
import config from '../config';

interface AuthenticatedSocket extends Socket {
  userId?: string;
  userRole?: string;
}

let io: SocketServer;

export const initializeSocket = (httpServer: HttpServer): SocketServer => {
  io = new SocketServer(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  // ── Auth middleware ──
  io.use(async (socket: AuthenticatedSocket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace('Bearer ', '');
      if (!token) return next(new Error('Authentication required'));

      const decoded = jwt.verify(token, config.jwt.secret) as any;
      const user = await User.findById(decoded.userId).select('_id role');
      if (!user) return next(new Error('User not found'));

      socket.userId = user._id.toString();
      socket.userRole = user.role;
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket: AuthenticatedSocket) => {
    const userId = socket.userId!;
    const role = socket.userRole!;

    console.log(`[Socket] ${role} connected: ${userId}`);

    // Join personal room
    socket.join(`user:${userId}`);

    // ── Driver events ──
    if (role === 'driver') {
      socket.join('drivers:online');

      // Real-time location update
      socket.on('driver:location', async (data: { lat: number; lng: number; heading?: number }) => {
        try {
          await User.findByIdAndUpdate(userId, {
            'driverProfile.currentLocation': {
              type: 'Point',
              coordinates: [data.lng, data.lat],
            },
          });

          // Broadcast to any ride the driver is on
          const { Ride } = await import('../models');
          const activeRide = await Ride.findOne({
            driver: userId,
            status: { $in: ['driver_assigned', 'driver_arriving', 'driver_arrived', 'in_progress'] },
          });

          if (activeRide) {
            io.to(`ride:${activeRide._id}`).emit('driver:location:update', {
              rideId: activeRide._id,
              location: data,
              timestamp: Date.now(),
            });
          }
        } catch (err) {
          console.error('[Socket] Location update error:', err);
        }
      });

      // Driver goes online/offline
      socket.on('driver:toggle-online', (data: { isOnline: boolean }) => {
        if (data.isOnline) {
          socket.join('drivers:online');
        } else {
          socket.leave('drivers:online');
        }
      });
    }

    // ── Ride events ──
    socket.on('ride:join', (rideId: string) => {
      socket.join(`ride:${rideId}`);
      console.log(`[Socket] ${role} ${userId} joined ride:${rideId}`);
    });

    socket.on('ride:leave', (rideId: string) => {
      socket.leave(`ride:${rideId}`);
    });

    // ── Chat events ──
    socket.on('chat:message', (data: { rideId: string; message: string; type?: string }) => {
      io.to(`ride:${data.rideId}`).emit('chat:new-message', {
        rideId: data.rideId,
        sender: userId,
        message: data.message,
        type: data.type || 'text',
        timestamp: Date.now(),
      });
    });

    socket.on('chat:typing', (data: { rideId: string }) => {
      socket.to(`ride:${data.rideId}`).emit('chat:typing', {
        userId,
        rideId: data.rideId,
      });
    });

    // ── Disconnect ──
    socket.on('disconnect', async () => {
      console.log(`[Socket] ${role} disconnected: ${userId}`);
      if (role === 'driver') {
        socket.leave('drivers:online');
      }
    });
  });

  return io;
};

// ── Emit helpers ──
export const emitToUser = (userId: string, event: string, data: any) => {
  if (io) io.to(`user:${userId}`).emit(event, data);
};

export const emitToRide = (rideId: string, event: string, data: any) => {
  if (io) io.to(`ride:${rideId}`).emit(event, data);
};

export const emitToOnlineDrivers = (event: string, data: any) => {
  if (io) io.to('drivers:online').emit(event, data);
};

/**
 * Notify nearby drivers about a new ride request
 */
export const notifyNearbyDrivers = async (rideId: string, pickup: { lat: number; lng: number }, radiusKm: number = 5) => {
  try {
    const nearbyDrivers = await User.find({
      role: 'driver',
      'driverProfile.isOnline': true,
      'driverProfile.isAvailable': true,
      'driverProfile.currentLocation': {
        $nearSphere: {
          $geometry: { type: 'Point', coordinates: [pickup.lng, pickup.lat] },
          $maxDistance: radiusKm * 1000,
        },
      },
    }).select('_id');

    nearbyDrivers.forEach((driver) => {
      emitToUser(driver._id.toString(), 'ride:new-request', { rideId, pickup });
    });

    return nearbyDrivers.length;
  } catch (err) {
    console.error('[Socket] notifyNearbyDrivers error:', err);
    return 0;
  }
};

export const getIO = (): SocketServer => {
  if (!io) throw new Error('Socket.IO not initialized');
  return io;
};
