'use client';

import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { statusToLifecycleStage } from '@dabzzo/shared-lib/orderLifecycle';

// ── Map icons ─────────────────────────────────────────────────────────────────
function createSvgIcon(svgHtml: string, size: [number, number], anchor: [number, number]) {
  return L.divIcon({ html: svgHtml, className: '', iconSize: size, iconAnchor: anchor });
}

const riderIcon = createSvgIcon(
  `<div style="
    width:44px;height:44px;border-radius:50%;background:#ff6b00;
    display:flex;align-items:center;justify-content:center;
    box-shadow:0 6px 20px rgba(255,107,0,.5);
    border:3px solid white;font-size:20px;
  ">🛵</div>`,
  [44, 44], [22, 22]
);

const destIcon = createSvgIcon(
  `<div style="
    width:36px;height:36px;border-radius:50%;background:#0f172a;
    display:flex;align-items:center;justify-content:center;
    box-shadow:0 4px 14px rgba(0,0,0,.3);
    border:3px solid white;font-size:16px;
  ">🏠</div>`,
  [36, 36], [18, 36]
);

function MapMover({ lat, lng }: { lat: number; lng: number }) {
  const map = useMap();
  const prev = useRef<{ lat: number; lng: number } | null>(null);
  useEffect(() => {
    if (prev.current && Math.abs(prev.current.lat - lat) < 0.00005 && Math.abs(prev.current.lng - lng) < 0.00005) return;
    prev.current = { lat, lng };
    map.flyTo([lat, lng], map.getZoom(), { animate: true, duration: 1.2 });
  }, [lat, lng, map]);
  return null;
}

function PulseRing({ color = '#ff6b00' }: { color?: string }) {
  return <span className="absolute inset-0 rounded-full animate-ping opacity-30" style={{ background: color }} />;
}

// ── Status config ─────────────────────────────────────────────────────────────
export type TrackingStatus =
  | 'created' | 'pending' | 'vendor_notified' | 'vendor_preparing' | 'cooking' | 'preparing'
  | 'vendor_ready' | 'ready' | 'dispatched'
  | 'rider_assigned' | 'rider_en_route_pickup' | 'picking_up' | 'picked_up' | 'out_for_delivery'
  | 'delivered' | 'completed' | 'failed_attempt' | 'failed' | 'cancelled';

interface Step { key: TrackingStatus; label: string; emoji: string; desc: string; color: string }
const STEPS: Step[] = [
  { key: 'preparing',        label: 'Preparing',  emoji: '👨‍🍳', desc: 'Kitchen is lovingly packing your tiffin',   color: 'from-orange-400 to-amber-500' },
  { key: 'rider_assigned',   label: 'Assigned',   emoji: '🏃', desc: 'Rider assigned and heading to kitchen',       color: 'from-amber-500 to-yellow-500' },
  { key: 'picked_up',        label: 'Picked Up',  emoji: '📦', desc: 'Rider has collected your order — on the way!', color: 'from-blue-400 to-indigo-500'   },
  { key: 'out_for_delivery', label: 'En Route',   emoji: '🛵', desc: 'Rider is heading straight to your door',       color: 'from-violet-400 to-purple-500'  },
  { key: 'delivered',        label: 'Delivered',  emoji: '✅', desc: 'Your tiffin has arrived. Enjoy!',              color: 'from-emerald-400 to-teal-500'   },
];

function getStepIndex(status: TrackingStatus): number {
  // Single mapping from the shared lifecycle model so every canonical status
  // renders a meaningful checkpoint (previously anything outside the 6-status
  // switch fell back to step 0 with a raw status pill).
  const stage = statusToLifecycleStage(status);
  return stage ? stage.index : 0;
}

const STATUS_MESSAGES: Partial<Record<TrackingStatus, string[]>> = {
  created:          ['Your order is confirmed 🎉', "We're getting the kitchen ready"],
  pending:          ['Order placed — stay tuned 🍱', 'Preparing schedule for today'],
  vendor_notified:  ['Kitchen has been notified 🍳', 'Cooking will start soon'],
  vendor_preparing: ['Your tiffin is being packed fresh 🍱', 'Almost ready for pickup!'],
  preparing:        ['Your tiffin is being packed fresh 🍱', 'Almost ready for pickup!'],
  cooking:          ['Cooking in progress 🍲', 'Fresh tiffin underway'],
  vendor_ready:     ['Tiffin packed! Waiting for rider 🛵', 'Rider will pick up soon'],
  ready:            ['Tiffin packed! Ready for dispatch 🛵', 'Waiting for rider assignment'],
  dispatched:       ['Boxed and handed to rider 🚚', 'On its way to you'],
  rider_assigned:   ['Rider is heading to the kitchen 🏃', 'Your order is being assigned'],
  rider_en_route_pickup: ['Rider en route to the kitchen 🏃', 'Pickup is happening now'],
  picking_up:       ['Rider is collecting your order 📦', 'Pickup in progress'],
  picked_up:        ['Rider has your order! 🎉', 'Fresh & warm, on the way to you'],
  out_for_delivery: ['Your rider is en route 🛵💨', 'GPS map is now live!'],
  delivered:        ['Delivered! Enjoy your meal 🎉', 'Rate your experience below'],
  completed:        ['Delivered! Enjoy your meal 🎉', 'Rate your experience below'],
};

// ── Live countdown hook ───────────────────────────────────────────────────────
function useLiveCountdown(targetTime: string) {
  const [timeLeft, setTimeLeft] = useState('');
  useEffect(() => {
    const [h, m] = targetTime.split(':').map(Number);
    const update = () => {
      const now = new Date();
      const target = new Date();
      target.setHours(h, m, 0, 0);
      const diff = target.getTime() - now.getTime();
      if (diff <= 0) { setTimeLeft('Arriving now'); return; }
      const mins = Math.floor(diff / 60000);
      const hrs = Math.floor(mins / 60);
      const rem = mins % 60;
      setTimeLeft(hrs > 0 ? `${hrs}h ${rem}m` : `${mins}m`);
    };
    update();
    const id = setInterval(update, 30000);
    return () => clearInterval(id);
  }, [targetTime]);
  return timeLeft;
}

// ── Props ─────────────────────────────────────────────────────────────────────
interface RiderTrackingCardProps {
  status: TrackingStatus;
  mealName?: string;
  mealType: 'lunch' | 'dinner' | 'both';
  scheduledSlot?: string;
  riderName?: string;
  riderPhone?: string;
  riderRating?: number;
  vehicleNumber?: string;
  otp?: string;
  boxTag?: string;
  driverLocation?: { lat: number; lng: number };
  destLocation?: { lat: number; lng: number };
  onCallRider?: (phone: string) => void;
  className?: string;
}

export function RiderTrackingCard({
  status,
  mealName = 'Tiffin',
  mealType,
  scheduledSlot,
  riderName = 'Dabzzo Rider',
  riderPhone,
  riderRating = 4.8,
  vehicleNumber,
  otp,
  boxTag,
  driverLocation,
  destLocation,
  onCallRider,
  className = '',
}: RiderTrackingCardProps) {
  const [revealOtp, setRevealOtp] = useState(false);
  const [copiedPin, setCopiedPin] = useState(false);
  const [msgIdx, setMsgIdx] = useState(0);

  // Compute accurate ETA hour from scheduledSlot, falling back to meal type
  const etaHour = scheduledSlot === '8am' ? 8
    : scheduledSlot === '11am' ? 11
    : scheduledSlot === '8pm' ? 20
    : mealType === 'dinner' ? 20 : 13;
  const etaTarget = `${String(etaHour).padStart(2, '0')}:00`;
  const etaLabel = scheduledSlot === '8am' ? '8:00 AM'
    : scheduledSlot === '11am' ? '11:00 AM'
    : scheduledSlot === '8pm' ? '8:00 PM'
    : mealType === 'dinner' ? '8:00 PM' : '1:00 PM';
  const countdown = useLiveCountdown(etaTarget);

  // Cycle through status messages
  const msgs = STATUS_MESSAGES[status] ?? STATUS_MESSAGES.preparing!;
  useEffect(() => {
    setMsgIdx(0);
    const id = setInterval(() => setMsgIdx((i) => (i + 1) % msgs.length), 4000);
    return () => clearInterval(id);
  }, [status, msgs.length]);

  const stepIndex = getStepIndex(status);
  const activeStep = status === 'vendor_ready'
    ? { key: 'vendor_ready' as TrackingStatus, label: 'Ready', emoji: '🍱', desc: 'Tiffin packed! Waiting for rider to pick up', color: 'from-amber-400 to-orange-500' }
    : (STEPS[stepIndex] ?? STEPS[0]);
  const isDelivered = status === 'delivered';
  const isCancelled = status === 'cancelled';
  const hasValidGps = !!driverLocation && typeof driverLocation.lat === 'number' && typeof driverLocation.lng === 'number';
  const showMap = !isDelivered && !isCancelled && hasValidGps;
  const showRider = ['rider_assigned', 'vendor_ready', 'picked_up', 'out_for_delivery', 'delivered'].includes(status) || !!riderPhone;

  return (
    <div className={`space-y-3 ${className}`}>

      {/* ── Hero Banner ── */}
      <motion.div
        key={status}
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        className={`relative overflow-hidden rounded-[28px] p-6 bg-gradient-to-br ${
          isDelivered ? 'from-emerald-500 to-teal-600'
          : isCancelled ? 'from-red-500 to-rose-600'
          : activeStep.color
        }`}
      >
        {/* Decorative rings */}
        <div className="absolute inset-0 opacity-[0.08]">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="absolute rounded-full border-2 border-white"
              style={{ width: 60 + i * 70, height: 60 + i * 70, top: '50%', left: '50%', transform: 'translate(-50%,-50%)' }}
            />
          ))}
        </div>

        <div className="relative z-10 flex items-start justify-between gap-4">
          <div className="flex-1">
            <p className="text-white/70 text-[10px] font-black uppercase tracking-widest mb-1">
              {isDelivered ? 'Delivered!' : isCancelled ? 'Order Cancelled' : 'Estimated Arrival'}
            </p>
            <div className="flex items-baseline gap-2 mb-3">
              <span className="text-[36px] font-black text-white leading-none">
                {isDelivered ? '🎉' : isCancelled ? '😔' : etaLabel}
              </span>
              {!isDelivered && !isCancelled && (
                <span className="text-white/60 text-sm font-semibold">today</span>
              )}
            </div>

            {/* Cycling message */}
            <AnimatePresence mode="wait">
              <motion.p
                key={`${status}-${msgIdx}`}
                initial={{ opacity: 0, x: 8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -8 }}
                transition={{ duration: 0.3 }}
                className="text-white/80 text-xs font-semibold"
              >
                {msgs[msgIdx]}
              </motion.p>
            </AnimatePresence>
          </div>

          {/* Countdown pill */}
          {!isDelivered && !isCancelled && (
            <div className="bg-white/20 backdrop-blur rounded-2xl px-3 py-2 text-center shrink-0">
              <p className="text-white/70 text-[9px] font-black uppercase tracking-wider">ETA in</p>
              <p className="text-white text-sm font-black mt-0.5">{countdown}</p>
            </div>
          )}
        </div>

        {/* Status pill */}
        <div className="relative z-10 mt-4 flex items-center gap-2">
          <motion.div
            key={status}
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="flex items-center gap-2 px-3 py-1.5 bg-white/15 backdrop-blur rounded-full"
          >
            <span className="text-sm">{activeStep.emoji}</span>
            <span className="text-white text-[11px] font-black uppercase tracking-wider">{activeStep.label}</span>
          </motion.div>
          {!isDelivered && !isCancelled && (
            <div className="flex gap-1">
              {[0, 1, 2].map((i) => (
                <motion.div key={i} className="w-1.5 h-1.5 rounded-full bg-white/50"
                  animate={{ opacity: [0.3, 1, 0.3] }}
                  transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2 }}
                />
              ))}
            </div>
          )}
        </div>
      </motion.div>

      {/* ── Progress Steps ── */}
      <div className="bg-white rounded-[24px] p-5 shadow-sm border border-slate-100">
        <div className="relative flex items-start justify-between">
          {/* Track line bg */}
          <div className="absolute top-5 left-5 right-5 h-0.5 bg-slate-100" />
          {/* Fill */}
          <motion.div
            className="absolute top-5 left-5 h-0.5 bg-gradient-to-r from-brand to-brand/70 origin-left"
            initial={{ scaleX: 0 }}
            animate={{ scaleX: Math.max(0, stepIndex) / (STEPS.length - 1) }}
            style={{ width: 'calc(100% - 40px)' }}
            transition={{ duration: 0.7, ease: 'easeOut' }}
          />

          {STEPS.map((step, idx) => {
            const isDone = idx < stepIndex;
            const isNow = idx === stepIndex;
            return (
              <div key={step.key} className="flex flex-col items-center gap-2 relative z-10">
                <motion.div
                  animate={{ scale: isNow ? [1, 1.15, 1] : 1 }}
                  transition={{ duration: 1.8, repeat: isNow ? Infinity : 0, ease: 'easeInOut' }}
                  className={`relative w-10 h-10 rounded-full flex items-center justify-center text-base border-2 transition-all duration-300
                    ${isDone ? 'bg-brand border-brand text-white shadow-md shadow-brand/30'
                    : isNow  ? 'bg-brand/10 border-brand text-brand'
                    :          'bg-white border-slate-200 text-slate-300'}`}
                >
                  {isNow && <PulseRing />}
                  <span>{isDone ? '✓' : step.emoji}</span>
                </motion.div>
                <span className={`text-[9px] font-black uppercase tracking-wide text-center leading-tight max-w-[52px]
                  ${isNow ? 'text-brand' : isDone ? 'text-slate-600' : 'text-slate-300'}`}>
                  {step.label}
                </span>
              </div>
            );
          })}
        </div>

        <AnimatePresence mode="wait">
          <motion.p
            key={status}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className="text-center text-xs text-slate-500 font-medium mt-5 pt-4 border-t border-slate-50"
          >
            {activeStep.desc}
          </motion.p>
        </AnimatePresence>
      </div>

      {/* ── Box Tag & OTP Card (visible when out for delivery or rider assigned) ── */}
      <AnimatePresence>
        {otp && ['rider_assigned', 'vendor_ready', 'picked_up', 'out_for_delivery'].includes(status) && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="overflow-hidden rounded-[24px] border border-slate-200/80 bg-white p-5 shadow-[0_4px_24px_rgba(15,23,42,0.04)] space-y-4"
          >
            {/* Box Tag Banner */}
            {boxTag && (
              <div className="bg-slate-900 text-white rounded-2xl p-4 flex items-center justify-between border border-slate-800 shadow-md">
                <div>
                  <span className="text-[10px] font-black uppercase tracking-wider text-amber-400">
                    🏷️ Your Tiffin Box Tag Code
                  </span>
                  <div className="text-2xl font-mono font-black text-white tracking-widest mt-0.5">
                    {boxTag}
                  </div>
                  <p className="text-[10px] text-slate-400 font-medium mt-0.5">
                    Verify this code on your tiffin container at delivery
                  </p>
                </div>
                <span className="px-2.5 py-1 bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 rounded-xl text-[10px] font-black uppercase tracking-wider">
                  Match Tag ✓
                </span>
              </div>
            )}

            <div className="flex items-center justify-between gap-3 bg-emerald-50/70 border border-emerald-100 rounded-2xl p-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-black uppercase tracking-widest text-emerald-800 bg-emerald-100 px-2 py-0.5 rounded-md">
                    {status === 'out_for_delivery' ? '⚡ Delivery PIN' : 'Handover PIN'}
                  </span>
                  {copiedPin && (
                    <span className="text-[10px] font-bold text-emerald-600 animate-pulse">
                      Copied! ✓
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-600 font-medium mt-1">
                  Share this 4-digit PIN with your delivery partner only when receiving the box.
                </p>
              </div>

              <div className="flex items-center gap-2">
                {revealOtp ? (
                  <motion.div
                    initial={{ scale: 0.8 }}
                    animate={{ scale: 1 }}
                    className="flex gap-1 font-mono"
                  >
                    {otp.split('').map((digit, i) => (
                      <motion.span
                        key={i}
                        initial={{ opacity: 0, y: -8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: i * 0.06 }}
                        className="w-8 h-10 flex items-center justify-center text-xl font-black text-emerald-800 bg-white border-2 border-emerald-300 rounded-xl shadow-xs"
                      >
                        {digit}
                      </motion.span>
                    ))}
                  </motion.div>
                ) : (
                  <button
                    onClick={() => setRevealOtp(true)}
                    className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-black rounded-xl shadow-md shadow-emerald-600/20 active:scale-95 transition-all"
                  >
                    Reveal PIN
                  </button>
                )}

                <button
                  onClick={() => {
                    navigator.clipboard.writeText(otp);
                    setCopiedPin(true);
                    setRevealOtp(true);
                    setTimeout(() => setCopiedPin(false), 2000);
                  }}
                  className="p-2.5 bg-white border border-emerald-200 hover:bg-emerald-100 text-emerald-700 rounded-xl shadow-xs active:scale-95 transition-all flex items-center justify-center"
                  title="Copy Delivery PIN"
                >
                  <span className="text-xs font-bold">📋</span>
                </button>
              </div>
            </div>

            {/* Blinking alert when rider is nearby */}
            {status === 'out_for_delivery' && (
              <motion.div
                animate={{ opacity: [0.7, 1, 0.7] }}
                transition={{ duration: 1.5, repeat: Infinity }}
                className="mt-3 flex items-center gap-2 bg-emerald-100 rounded-xl px-3 py-2"
              >
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping shrink-0" />
                <p className="text-[10px] font-bold text-emerald-700">Your rider is on the way to your door right now</p>
              </motion.div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Live Map ── */}
      <AnimatePresence>
        {showMap && driverLocation && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden rounded-[24px] border border-slate-100 shadow-md"
          >
            <div className="relative">
              <div className="absolute top-3 left-3 z-[999] flex items-center gap-1.5 bg-red-500 text-white text-[9px] font-black uppercase tracking-wider px-2.5 py-1 rounded-full shadow-md">
                <span className="w-1.5 h-1.5 rounded-full bg-white animate-ping" />
                Live GPS
              </div>
              <MapContainer
                center={[driverLocation.lat, driverLocation.lng]}
                zoom={15}
                scrollWheelZoom={false}
                dragging={false}
                touchZoom={false}
                style={{ height: 240, width: '100%' }}
                zoomControl={false}
              >
                <TileLayer
                  attribution='&copy; OpenStreetMap'
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                <MapMover lat={driverLocation.lat} lng={driverLocation.lng} />
                <Marker position={[driverLocation.lat, driverLocation.lng]} icon={riderIcon}>
                  <Popup><span className="text-xs font-bold">🛵 {riderName}</span></Popup>
                </Marker>
                {destLocation && typeof destLocation.lat === 'number' && typeof destLocation.lng === 'number' && destLocation.lat !== 0 && destLocation.lng !== 0 && (
                  <Marker position={[destLocation.lat, destLocation.lng]} icon={destIcon}>
                    <Popup><span className="text-xs font-bold">🏠 Your location</span></Popup>
                  </Marker>
                )}
              </MapContainer>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Rider Info Card ── */}
      <AnimatePresence>
        {showRider && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-white rounded-[24px] p-4 shadow-sm border border-slate-100"
          >
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-3">Your Rider</p>
            <div className="flex items-center gap-3">
              <div className="relative w-14 h-14 rounded-2xl bg-gradient-to-br from-brand/10 to-orange-50 flex items-center justify-center text-2xl shrink-0 border border-brand/10">
                🛵
                {status === 'out_for_delivery' && (
                  <span className="absolute -bottom-1 -right-1 w-4 h-4 bg-emerald-500 rounded-full border-2 border-white animate-pulse" />
                )}
              </div>

              <div className="flex-1 min-w-0">
                <h4 className="font-black text-slate-900 text-sm leading-tight">{riderName}</h4>
                {vehicleNumber && (
                  <p className="text-[10px] font-bold text-slate-400 mt-0.5">{vehicleNumber}</p>
                )}
                <div className="flex items-center gap-1 mt-1">
                  {[...Array(5)].map((_, i) => (
                    <span key={i} className={`text-[11px] ${i < Math.round(riderRating) ? 'text-amber-400' : 'text-slate-200'}`}>★</span>
                  ))}
                  <span className="text-[10px] font-bold text-slate-400 ml-0.5">{riderRating}</span>
                </div>
              </div>

              {riderPhone && onCallRider && (
                <button
                  onClick={() => onCallRider(riderPhone)}
                  className="w-12 h-12 rounded-2xl bg-gradient-to-br from-brand to-orange-500 text-white flex items-center justify-center shadow-lg shadow-brand/30 active:scale-95 transition-all shrink-0"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.68 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.59 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.56a16 16 0 0 0 6.29 6.29l1.41-1.41a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>
                  </svg>
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Delivered celebration ── */}
      <AnimatePresence>
        {isDelivered && (
          <motion.div
            initial={{ scale: 0.85, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring', bounce: 0.4 }}
            className="bg-gradient-to-br from-emerald-50 to-teal-50 border border-emerald-100 rounded-[24px] p-6 text-center"
          >
            <motion.div
              animate={{ rotate: [0, -10, 10, -10, 0], scale: [1, 1.2, 1] }}
              transition={{ duration: 0.6, delay: 0.2 }}
              className="text-5xl mb-3"
            >
              🎉
            </motion.div>
            <h3 className="font-black text-emerald-800 text-lg">Enjoy your meal!</h3>
            <p className="text-emerald-600 text-xs font-medium mt-1">{mealName} has been delivered fresh to you</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
