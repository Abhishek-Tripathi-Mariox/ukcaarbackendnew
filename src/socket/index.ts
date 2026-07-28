import { Server as SocketServer, Socket } from 'socket.io';
import { Server as HttpServer } from 'http';
import { createClient } from 'redis';
import { createAdapter } from '@socket.io/redis-adapter';
import jwt from 'jsonwebtoken';
import { User } from '../models';
import { APPROVED_DRIVER_QUERY } from '../middleware/driverApproval';
import config from '../config';
import { redisSocketOptions } from '../config/redis';

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

      // Real-time location update.
      // The User schema stores currentLocation as a flat { lat, lng } subdoc
      // (see User.ts), and the customer's getNearbyDrivers reads it the same
      // way. An earlier version of this handler wrote it as GeoJSON
      // ({ type: 'Point', coordinates: [lng, lat] }) — Mongoose then dropped
      // the write entirely because those fields aren't in the schema, which
      // is why the customer map showed no drivers despite green-dotted
      // online drivers in admin.
      socket.on('driver:location', async (data: { lat: number; lng: number; heading?: number }) => {
        try {
          if (typeof data?.lat !== 'number' || typeof data?.lng !== 'number') {
            return;
          }
          await User.findByIdAndUpdate(userId, {
            'driverProfile.currentLocation': { lat: data.lat, lng: data.lng },
          });
          console.log(
            `[Socket] location ${userId} -> ${data.lat.toFixed(5)},${data.lng.toFixed(5)}`,
          );

          // Broadcast to any ride the driver is on
          const { Ride } = await import('../models');
          const activeRide = await Ride.findOne({
            driver: userId,
            status: { $in: ['driver_assigned', 'driver_arriving', 'driver_arrived', 'in_progress'] },
          });

          // Scheduled routes don't create a Ride doc until a customer
          // actually books a seat — and even then booking happens through
          // a separate flow. We still want the rider's "track this
          // shuttle" UI to show the bus moving, so we ALSO fan the GPS
          // ping out to any Route this driver is approved + active on.
          // Cheap query: registeredDrivers is an embedded array indexed
          // by (driver, status), one round-trip per ping.
          try {
            const { Route } = await import('../models');
            const driverRoutes = await Route.find(
              {
                isActive: true,
                type: 'scheduled',
                registeredDrivers: {
                  $elemMatch: { driver: userId, status: 'approved' },
                },
              },
              { _id: 1 },
            ).lean();
            for (const r of driverRoutes) {
              io.to(`route:${r._id}`).emit('driver:location:update', {
                routeId: r._id,
                driverId: userId,
                location: data,
                timestamp: Date.now(),
              });
            }
          } catch (err) {
            console.warn('[Socket] route fan-out failed:', err);
          }

          if (activeRide) {
            io.to(`ride:${activeRide._id}`).emit('driver:location:update', {
              rideId: activeRide._id,
              location: data,
              timestamp: Date.now(),
            });

            // ── Geofence-based auto status transitions ────────────────
            // Two automatic flips happen here so the rider's UI doesn't
            // depend on the driver tapping buttons:
            //   1. driver_assigned → driver_arriving: as soon as we get
            //      the first GPS update post-acceptance, treat the
            //      driver as en route.
            //   2. driver_arriving → driver_arrived: when the driver
            //      gets within 100 m of the pickup. 100 m matches the
            //      "I'm at the gate" UX rideshare apps use.
            //
            // We use haversine — accurate to a few metres at this scale
            // and avoids a Google Distance Matrix round-trip on every
            // GPS ping. Driver app sends locations every ~5s so we'd
            // burn API quota quickly otherwise.
            const haversineMeters = (
              a: { lat: number; lng: number },
              b: { lat: number; lng: number },
            ): number => {
              const R = 6371000;
              const dLat = ((b.lat - a.lat) * Math.PI) / 180;
              const dLng = ((b.lng - a.lng) * Math.PI) / 180;
              const lat1 = (a.lat * Math.PI) / 180;
              const lat2 = (b.lat * Math.PI) / 180;
              const h =
                Math.sin(dLat / 2) ** 2 +
                Math.sin(dLng / 2) ** 2 *
                  Math.cos(lat1) *
                  Math.cos(lat2);
              return 2 * R * Math.asin(Math.sqrt(h));
            };

            if (
              activeRide.pickup &&
              typeof activeRide.pickup.lat === 'number' &&
              typeof activeRide.pickup.lng === 'number'
            ) {
              const distToPickupM = haversineMeters(
                { lat: data.lat, lng: data.lng },
                { lat: activeRide.pickup.lat, lng: activeRide.pickup.lng },
              );

              let nextStatus: string | null = null;
              if (
                activeRide.status === 'driver_assigned' &&
                distToPickupM > 100
              ) {
                // Driver moving toward pickup — flip to "on the way".
                nextStatus = 'driver_arriving';
              } else if (
                (activeRide.status === 'driver_assigned' ||
                  activeRide.status === 'driver_arriving') &&
                distToPickupM <= 100
              ) {
                // Driver is at the pickup — show "waiting".
                nextStatus = 'driver_arrived';
              }

              if (nextStatus) {
                activeRide.status = nextStatus as any;
                await activeRide.save();
                const statusPayload = {
                  rideId: String(activeRide._id),
                  status: nextStatus,
                  ride: activeRide,
                };
                io.to(`ride:${activeRide._id}`).emit('ride:status', statusPayload);
                io.to(`user:${String(activeRide.customer)}`).emit('ride:status', statusPayload);
                io.to(`user:${userId}`).emit('ride:status', statusPayload);
                console.log(
                  `[geo] ride=${activeRide._id} ${nextStatus} (${distToPickupM.toFixed(0)}m to pickup)`,
                );

                // Push the most rider-visible transition (driver_arrived).
                // The "driver_arriving" flip is constant chatter as soon as
                // the driver moves — no point pinging the OS for it. Lazy
                // import so the socket module doesn't pull fcmController
                // (which transitively depends on models) at load time.
                if (nextStatus === 'driver_arrived') {
                  const { sendPushToUser } = await import('../controllers/fcmController');
                  const { templatedCopy } = await import('../services/notificationTemplate');
                  const arrivedCopy = await templatedCopy(
                    'ride.driver_arrived',
                    {},
                    { title: 'Your driver has arrived', body: 'They are waiting at your pickup point.' },
                  );
                  sendPushToUser(String(activeRide.customer), {
                    title: arrivedCopy.title,
                    body: arrivedCopy.body,
                    data: {
                      kind: 'ride:status',
                      rideId: String(activeRide._id),
                      status: 'driver_arrived',
                    },
                  }).catch(err => console.warn('[geo] arrived push failed:', err));
                }
              }
            }
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

    // ── Scheduled-route rooms ──
    // Customers waiting for / riding a scheduled shuttle join their
    // route's room to receive `driver:location:update` events for the
    // bus, even though no `Ride` document exists for the seat reservation.
    socket.on('route:join', (routeId: string) => {
      if (!routeId) return;
      socket.join(`route:${routeId}`);
      console.log(`[Socket] ${role} ${userId} joined route:${routeId}`);
    });

    socket.on('route:leave', (routeId: string) => {
      if (!routeId) return;
      socket.leave(`route:${routeId}`);
    });

    // ── Chat events ──
    socket.on('chat:message', async (data: { rideId: string; message: string; type?: string }) => {
      try {
        if (!data?.rideId || !data?.message) return;

        // Echo to anyone in the ride room first — instant delivery for
        // foregrounded apps shouldn't wait on the DB write.
        const payload = {
          rideId: data.rideId,
          sender: userId,
          message: data.message,
          type: data.type || 'text',
          timestamp: Date.now(),
        };
        io.to(`ride:${data.rideId}`).emit('chat:new-message', payload);

        // Persist + push. Lazy-import to avoid pulling models/fcmController
        // into the socket module's load-time graph.
        const { Chat, Ride } = await import('../models');
        const { sendPushToUser } = await import('../controllers/fcmController');

        let chat = await Chat.findOne({ ride: data.rideId });
        if (!chat) {
          const ride = await Ride.findById(data.rideId).select('customer driver');
          if (!ride) return;
          chat = await Chat.create({
            ride: ride._id,
            participants: [ride.customer, ride.driver].filter(Boolean),
            messages: [],
          });
        }
        chat.messages.push({
          sender: userId as any,
          content: data.message,
          type: (data.type === 'image' || data.type === 'location' ? data.type : 'text') as any,
          read: false,
          createdAt: new Date(),
        });
        await chat.save();

        // Push to the other party so a backgrounded app surfaces the
        // notification. Sender is identified by userId; the recipient is
        // every other participant in the chat.
        const recipients = (chat.participants || []).filter(
          (p) => String(p) !== String(userId),
        );
        for (const r of recipients) {
          sendPushToUser(String(r), {
            title: 'New message',
            body: data.message.slice(0, 80),
            data: {
              kind: 'chat:new-message',
              rideId: data.rideId,
              sender: String(userId),
            },
          }).catch(err => console.warn('[chat] push failed:', err));
        }
      } catch (err) {
        console.error('[chat] message handler failed:', err);
      }
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

/**
 * Attach the Redis adapter so socket rooms + emits propagate across every
 * backend instance. Without this, `emitToUser` / `emitToRide` only reach
 * clients connected to the SAME Node process — which is why live tracking,
 * status, and chat silently fail across a multi-instance (or customer-server
 * / driver-server split) deployment.
 *
 * Call this once, after `initializeSocket`, during server bootstrap.
 *
 * No-op when REDIS_ENABLED is unset (single instance — the default in-memory
 * adapter is correct). Failures are non-fatal: we log and keep the in-memory
 * adapter so the server still boots, just without cross-instance fan-out.
 */
export const initSocketRedisAdapter = async (): Promise<void> => {
  if (!config.redis.enabled) {
    console.log(
      '[socket] Redis adapter disabled (single-instance, in-memory). ' +
        'Set REDIS_ENABLED=true on every instance to share rooms across them.',
    );
    return;
  }
  if (!io) {
    console.warn('[socket] initSocketRedisAdapter called before initializeSocket — skipped');
    return;
  }
  try {
    const pubClient = createClient({ url: config.redis.url, socket: redisSocketOptions });
    const subClient = pubClient.duplicate();
    pubClient.on('error', (err) =>
      console.warn('[socket][redis] pub error:', (err as Error)?.message ?? err),
    );
    subClient.on('error', (err) =>
      console.warn('[socket][redis] sub error:', (err as Error)?.message ?? err),
    );
    await Promise.all([pubClient.connect(), subClient.connect()]);
    io.adapter(createAdapter(pubClient, subClient));
    console.log(
      '[socket] Redis adapter active — rooms shared across instances:',
      config.redis.url,
    );
  } catch (err) {
    console.warn(
      '[socket] Redis adapter setup failed — continuing with in-memory adapter:',
      (err as Error)?.message ?? err,
    );
  }
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
      // Second emitter of 'ride:new-request' (currently unused — the live
      // fan-out is rideController.dispatchToNearbyDrivers). Carries the same
      // approval gate so wiring it up can't reopen the hole.
      ...APPROVED_DRIVER_QUERY,
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
