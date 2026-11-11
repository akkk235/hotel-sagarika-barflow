import express from 'express';
import { authenticate, manager, requireRole } from '../auth.js';
import { HttpError } from '../util.js';
import {
  checkIn,
  checkOut,
  occupancyHistory,
  releaseRoom,
  roomById,
  roomList,
  roomSummary,
  updateRoom,
} from '../lodging.js';

const router = express.Router();
const owner = requireRole('owner');

function wrap(handler) {
  return (req, res, next) => {
    try {
      handler(req, res, next);
    } catch (err) {
      next(err);
    }
  };
}

// Room board: 9 rooms with live occupancy + summary tiles.
router.get('/', authenticate, wrap((req, res) => {
  res.json({ rooms: roomList(), summary: roomSummary() });
}));

router.get('/summary', authenticate, wrap((req, res) => {
  res.json(roomSummary());
}));

router.get('/history', authenticate, wrap((req, res) => {
  const roomId = req.query.room_id ? Number(req.query.room_id) : null;
  res.json({ history: occupancyHistory({ limit: req.query.limit, roomId }) });
}));

router.get('/:id', authenticate, wrap((req, res) => {
  const room = roomById(req.params.id);
  if (!room) throw new HttpError(404, 'Room not found');
  res.json({ room, history: occupancyHistory({ limit: 20, roomId: room.id }) });
}));

// Manager may edit room name/number; only Owner may change floor, tariff or status.
router.patch('/:id', authenticate, manager, wrap((req, res) => {
  res.json({ room: updateRoom(req.params.id, req.body || {}, req.user) });
}));

// Owner-only operations.
router.post('/:id/checkin', authenticate, owner, wrap((req, res) => {
  res.status(201).json(checkIn(req.params.id, req.body || {}, req.user));
}));

router.post('/:id/checkout', authenticate, owner, wrap((req, res) => {
  res.json(checkOut(req.params.id, req.body || {}, req.user));
}));

router.post('/:id/release', authenticate, owner, wrap((req, res) => {
  res.json(releaseRoom(req.params.id, req.body || {}, req.user));
}));

export default router;
