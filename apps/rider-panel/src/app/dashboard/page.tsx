'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useAuthStore } from '@/store/authStore';
import { useDeliveryStore } from '@/store/deliveryStore';
import { 
  Navigation, 
  MapPin, 
  PackageOpen, 
  Truck, 
  Store, 
  LogOut, 
  Phone, 
  Loader2, 
  CheckCircle2, 
  ShieldCheck, 
  Compass, 
  ListOrdered
} from 'lucide-react';
import Image from 'next/image';
import { getImageUrl, uploadImage } from '@/lib/storage';
import { updateUser } from '@/lib/queries/users';
import toast from 'react-hot-toast';
import { collection, getDocs, query, where, doc, getDoc, writeBatch, updateDoc, onSnapshot, setDoc } from 'firebase/firestore';
import { db, functions } from '@/lib/firebase';
import { httpsCallable } from 'firebase/functions';
import dynamic from 'next/dynamic';
import { PendingVerificationScreen } from '@/components/shared/PendingVerificationScreen';
import { VegIcon, NonVegIcon, DietaryBadge } from '@/components/shared/DietaryIcon';
import { generateBoxTag } from '@/lib/boxTag';
import { LocationTracker } from '@/lib/delivery/locationTracker';
import { getErrorMessage } from '@dabzzo/shared-lib/errors';

const DeliveryMap = dynamic(() => import('@/components/delivery/DeliveryMap'), { ssr: false });

export default function RiderDashboard() {
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const logout = useAuthStore((s) => s.logout);
  const activeTrip = useDeliveryStore((s) => s.activeTrip);
  const agentOrders = useDeliveryStore((s) => s.agentOrders);

  const isSuper = user?.email?.toLowerCase().trim() === 'closeon.st@gmail.com' || user?.is_superadmin === true;
  const isRiderRole = user?.role === 'delivery' || (user?.role as string) === 'delivery_agent' || user?.roles?.delivery || user?.role === 'admin' || isSuper;
  const isVerifiedRider = isSuper || ((user?.is_approved === true || user?.verification_status === 'verified') && user?.is_rejected !== true && user?.is_suspended !== true && user?.verification_status !== 'rejected' && user?.verification_status !== 'details_requested');

  const [isMounting, setIsMounting] = useState(true);
  const [loadingImage, setLoadingImage] = useState(false);
  const [isOnline, setIsOnline] = useState(true);
  const [viewTab, setViewTab] = useState<'active' | 'itinerary'>('active');
  const failedOrdersRef = useRef<Set<string>>(new Set());

  // Kitchen Pickup Verification state
  const [vendorOTP, setVendorOTP] = useState('');
  const [verifyingVendorOTP, setVerifyingVendorOTP] = useState(false);
  const [pickupStep, setPickupStep] = useState<'otp' | 'count'>('otp');
  const [vendorDeclaredCount, setVendorDeclaredCount] = useState<number>(0);
  const [riderConfirmedCount, setRiderConfirmedCount] = useState<string>('');

  // Customer Drop-off Verification state
  const [dropoffOTP, setDropoffOTP] = useState('');
  const [verifyingDropoffOTP, setVerifyingDropoffOTP] = useState(false);

  // Customer unavailability timer state
  const [unavailabilityStartTimes, setUnavailabilityStartTimes] = useState<Record<string, number>>({});
  // Lazy initializer: reading the clock directly during render is impure.
  const [nowTick, setNowTick] = useState(() => Date.now());
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Current rider coordinates from active GPS
  const [riderLocation, setRiderLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [vendors, setVendors] = useState<any[]>([]);
  const [customerProfiles, setCustomerProfiles] = useState<Record<string, { name: string; phone?: string; image?: string; address?: string }>>({});
  const [navigatingVendorId, setNavigatingVendorId] = useState<string | null>(null);

  // ── Kitchen Navigation with Instant Fresh Coordinates Check ────────────────
  const handleNavigateToKitchen = async (
    vendorId: string,
    fallbackLat?: number,
    fallbackLng?: number,
    fallbackAddress?: string
  ) => {
    let targetLat = fallbackLat;
    let targetLng = fallbackLng;
    let targetAddress = fallbackAddress;

    if (vendorId) {
      setNavigatingVendorId(vendorId);
      try {
        const snap = await getDoc(doc(db, 'users', vendorId));
        if (snap.exists()) {
          const freshData = snap.data();
          const liveLat = freshData.location?.lat ?? freshData.lat;
          const liveLng = freshData.location?.lng ?? freshData.lng;
          const liveAddr = freshData.address || freshData.location?.address;
          if (typeof liveLat === 'number' && typeof liveLng === 'number') {
            targetLat = liveLat;
            targetLng = liveLng;
          }
          if (liveAddr) {
            targetAddress = liveAddr;
          }
          // Immediately sync local state so card and map reflect the fresh position
          setVendors(prev => {
            const exists = prev.some(v => v.id === vendorId);
            if (exists) {
              return prev.map(v => (v.id === vendorId ? { ...v, ...freshData } : v));
            }
            return [...prev, { id: vendorId, ...freshData }];
          });
        }
      } catch (err) {
        console.warn('[handleNavigateToKitchen] Fresh lookup failed, using cached coords:', err);
      } finally {
        setNavigatingVendorId(null);
      }
    }

    let url = '';
    if (typeof targetLat === 'number' && typeof targetLng === 'number') {
      url = `https://www.google.com/maps/dir/?api=1&destination=${targetLat},${targetLng}`;
    } else if (targetAddress) {
      url = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(targetAddress)}`;
    }

    if (url) {
      window.open(url, '_blank', 'noopener,noreferrer');
    } else {
      toast.error('Kitchen location is not available yet');
    }
  };

  // ── 1. Offline Sync Queue (Removed to prevent spoofing) ─────────────────────

  useEffect(() => {
    const timer = setTimeout(() => setIsMounting(false), 300);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // ── 2. Sync isOnline state from Firestore ─────────────────────────────────
  useEffect(() => {
    if (!user?.id) return;
    const profileRef = doc(db, 'driver_profiles', user.id);
    const unsub = onSnapshot(profileRef, (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        if (typeof data.isActive === 'boolean') {
          setIsOnline(data.isActive);
        }
      }
    }, () => { /* silently ignore */ });
    return () => unsub();
  }, [user?.id]);

  const handleToggleOnline = useCallback(async (newValue: boolean) => {
    setIsOnline(newValue);
    if (!user?.id) return;
    try {
      await setDoc(doc(db, 'driver_profiles', user.id), {
        id: user.id,
        uid: user.id,
        name: user.name || 'Dabzzo Rider',
        phone: user.phone || '',
        vehicleType: user.vehicle_type || 'Motorcycle',
        isActive: newValue,
        lastActive: new Date()
      }, { merge: true });
      if (!newValue) {
        await LocationTracker.stopTripTracking();
      }
      toast.success(newValue ? 'You are Online & On Duty 🛵' : 'You are Offline');
    } catch (e) {
      console.warn('Could not update online status:', e);
    }
  }, [user]);

  // ── 3. Battery-Smart GPS: Watch position ONLY while an active trip is ongoing ─
  useEffect(() => {
    const hasActiveTrip = isOnline && activeTrip && activeTrip.status !== 'completed';
    if (!hasActiveTrip || !user?.id) {
      LocationTracker.stopTripTracking().catch(() => {});
      return;
    }

    let watchId: number | null = null;
    if (typeof navigator !== 'undefined' && navigator.geolocation) {
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          setRiderLocation(loc);
          setDoc(doc(db, 'driver_profiles', user.id), {
            id: user.id,
            isActive: true,
            currentLocation: {
              ...loc,
              updatedAt: new Date()
            },
            lastActive: new Date()
          }, { merge: true }).catch((err) => console.warn('Location push failed:', err.message));
        },
        (err) => console.warn('Geolocation error:', err.message),
        { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 }
      );
    }

    return () => {
      if (watchId !== null && typeof navigator !== 'undefined') {
        navigator.geolocation.clearWatch(watchId);
      }
    };
  }, [isOnline, activeTrip?.id, activeTrip?.status, user?.id]);

  // ── 4. Fetch Vendors & Customer Profiles (Lightweight 20s Polling Sync) ────
  const fetchVendors = useCallback(async () => {
    try {
      const q = query(collection(db, 'users'), where('role', '==', 'vendor'));
      const snap = await getDocs(q);
      setVendors(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (err) {
      console.error('[RiderDashboard] Failed to fetch vendors:', err);
    }
  }, []);

  useEffect(() => {
    if (!user?.id) return;
    
    // Initial fetch
    fetchVendors();

    // Periodic sync every 20s (within 10-30s, zero realtime listener burden)
    const interval = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) {
        fetchVendors();
      }
    }, 20_000);

    // Sync immediately whenever rider returns to or focuses this window/tab
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        fetchVendors();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', fetchVendors);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', fetchVendors);
    };
  }, [user?.id, fetchVendors]);

  useEffect(() => {
    if (!agentOrders.length) return;
    const customerIds = [...new Set(agentOrders.map(o => (o as any).customerId || (o as any).user_id).filter(Boolean))];
    if (!customerIds.length) return;
    Promise.all(
      customerIds.map(async (id: string) => {
        const snap = await getDoc(doc(db, 'users', id));
        if (snap.exists()) {
          const d = snap.data();
          return [id, { name: d.name || d.displayName || 'Customer', phone: d.phone || d.phone_number, image: d.image, address: d.address || d.location_address }] as const;
        }
        return null;
      })
    ).then(results => {
      const map: Record<string, { name: string; phone?: string; image?: string; address?: string }> = {};
      results.forEach(r => { if (r) map[r[0]] = r[1]; });
      setCustomerProfiles(map);
    }).catch(err => {
      console.error('[RiderDashboard] Failed to fetch customer profiles:', err);
    });
  }, [agentOrders]);

  async function handleImageChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !user) return;
    setLoadingImage(true);
    try {
      const url = await uploadImage(file);
      if (url) {
        await updateUser(user.id, { image: url });
        setUser({ ...user, image: url });
        toast.success('Profile image updated!');
      }
    } catch {
      toast.error('Image upload failed');
    } finally {
      setLoadingImage(false);
    }
  }

  // ── 5. Active Stop Derivation ─────────────────────────────────────────────
  const pickupStopsList = activeTrip?.pickupStops || [];
  const pendingPickups = pickupStopsList.filter((s: any) => s.status !== 'completed');

  const remainingDrops = agentOrders.filter(o => o.status !== 'delivered' && o.status !== 'failed');
  if (activeTrip?.dropStops) {
    remainingDrops.sort((a, b) => {
      const stopA = activeTrip!.dropStops!.find((s: any) => s.orderId === a.id);
      const stopB = activeTrip!.dropStops!.find((s: any) => s.orderId === b.id);
      return (stopA?.sequence || 999) - (stopB?.sequence || 999);
    });
  }

  let currentState: 'IDLE' | 'PICKUP' | 'DELIVERY' = 'IDLE';
  let nextPickup: any = null;
  let currentDropOrder: any = null;

  if (activeTrip && activeTrip.status !== 'completed') {
    if (pendingPickups.length > 0) {
      currentState = 'PICKUP';
      nextPickup = pendingPickups[0];
    } else if (remainingDrops.length > 0) {
      currentState = 'DELIVERY';
      currentDropOrder = remainingDrops[0];
    }
  }

  const completedDropsCount = agentOrders.filter(o => o.status === 'delivered').length;
  const totalDropsCount = agentOrders.length;
  const totalPickupsCount = pickupStopsList.length;
  const completedPickupsCount = pickupStopsList.filter((s: any) => s.status === 'completed').length;
  const totalTasks = totalPickupsCount + totalDropsCount;
  const completedTasks = completedPickupsCount + completedDropsCount;
  const progressPct = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  // ── 6. Kitchen Pickup OTP & Quantity Verification ────────────────────────
  const handleVerifyVendorOTP = async () => {
    if (!activeTrip || !nextPickup || vendorOTP.length !== 4) {
      toast.error('Please enter the 4-digit Kitchen OTP');
      return;
    }
    setVerifyingVendorOTP(true);
    try {
      const tripRef = doc(db, 'rider_trips', activeTrip.id);
      const tripSnap = await getDoc(tripRef);
      if (!tripSnap.exists()) throw new Error('Trip not found');
      const tripData = tripSnap.data();

      let isValid = false;
      const batchIds = tripData.batch_ids || [];
      if (batchIds.length > 0) {
        const batchDocs = await Promise.all(batchIds.map((id: string) => getDoc(doc(db, 'batches', id))));
        const validOTPs = batchDocs.map(d => String(d.data()?.pickup_otp)).filter(Boolean);
        if (validOTPs.includes(String(vendorOTP))) isValid = true;
      }

      if (!isValid && tripData.pickupStops) {
        const vStop = tripData.pickupStops.find((s: any) => s.vendorId === nextPickup.vendorId);
        if (vStop && String(vStop.pickupOTP) === String(vendorOTP)) {
          isValid = true;
        }
      }

      if (!isValid && nextPickup.pickupOTP && String(nextPickup.pickupOTP) === String(vendorOTP)) {
        isValid = true;
      }

      if (!isValid) {
        toast.error('Invalid Kitchen OTP. Please ask chef for the code on vendor screen.');
        return;
      }

      const expectedCount = nextPickup.expectedTiffinCount || agentOrders.length || 1;
      setVendorDeclaredCount(expectedCount);
      setRiderConfirmedCount(String(expectedCount));
      setPickupStep('count');
      toast.success('Kitchen OTP Verified! ✓ Confirm tiffin count.');
    } catch (err: unknown) {
      toast.error(getErrorMessage(err) || 'Verification failed');
    } finally {
      setVerifyingVendorOTP(false);
    }
  };

  const handleConfirmPickupCount = async () => {
    if (!activeTrip || !nextPickup) return;
    const countInt = parseInt(riderConfirmedCount, 10);
    if (isNaN(countInt) || countInt <= 0) {
      toast.error('Please enter a valid count');
      return;
    }
    setVerifyingVendorOTP(true);
    try {
      const verifyPickupFn = httpsCallable(functions, 'verifyPickupOTP');
      const res = await verifyPickupFn({
        tripId: activeTrip.id,
        vendorId: nextPickup.vendorId,
        otp: vendorOTP,
        confirmedCount: countInt,
      });
      const data = res.data as { success: boolean; message?: string; allDone?: boolean; discrepancy?: number };
      if (!data.success) {
        toast.error(data.message || 'Verification failed');
        return;
      }

      if (data.discrepancy && data.discrepancy !== 0) {
        toast('Tiffin count discrepancy logged for admin review.', { icon: '⚠️' });
      }

      toast.success(data.allDone ? 'All Kitchen Meals Collected! Proceeding to Customer Deliveries 🛵' : 'Kitchen Pickup Completed! Proceeding to next stop.');
      setVendorOTP('');
      setPickupStep('otp');
    } catch (err: unknown) {
      toast.error(getErrorMessage(err) || 'Failed to confirm pickup');
    } finally {
      setVerifyingVendorOTP(false);
    }
  };

  // ── 7. Customer Drop-off OTP Verification ────────────────────────────────
  const handleVerifyDropoffOTP = async () => {
    if (!activeTrip || !currentDropOrder || dropoffOTP.length !== 4) {
      toast.error('Please enter the 4-digit Customer Delivery OTP');
      return;
    }
    setVerifyingDropoffOTP(true);
    try {
      const verifyFn = httpsCallable(functions, 'verifyDeliveryOTP');
      const result = await verifyFn({ orderId: currentDropOrder.id, otp: dropoffOTP });
      const data = result.data as { success: boolean; message: string };
      if (!data.success) {
        toast.error(data.message || 'Invalid OTP. Please check the 4-digit PIN on customer tracking screen.');
        return;
      }
      // Cloud function already marked order delivered
      // Just update local UI state
      const remaining = agentOrders.filter(o => o.id !== currentDropOrder.id && o.status !== 'delivered' && o.status !== 'failed');
      if (remaining.length === 0) {
        toast.success('All Deliveries Completed! Excellent run! 🎉');
      } else {
        toast.success(`Delivery #${completedDropsCount + 1} completed! Proceeding to next stop.`);
      }
      setDropoffOTP('');
    } catch (err: unknown) {
      toast.error('OTP verification failed: ' + (getErrorMessage(err) || 'Unknown error'));
    } finally {
      setVerifyingDropoffOTP(false);
    }
  };

  const handleStartUnavailability = async (orderId: string) => {
    try {
      const startFn = httpsCallable(functions, 'startCustomerUnavailability');
      const res = await startFn({ orderId });
      const data = res.data as { success: boolean; message?: string; unavailability_started_at?: number };
      if (!data.success) {
        toast.error(data.message || 'Failed to start timer');
        return;
      }
      setUnavailabilityStartTimes(prev => ({ ...prev, [orderId]: data.unavailability_started_at || Date.now() }));
      toast.success('10-minute customer waiting timer started. Alert sent to customer.');
    } catch (err: unknown) {
      toast.error(getErrorMessage(err) || 'Failed to start timer');
    }
  };

  const handleConfirmCustomerUnavailable = useCallback(async (orderId: string) => {
    if (!activeTrip) return;
    if (failedOrdersRef.current.has(orderId)) return;
    failedOrdersRef.current.add(orderId);
    try {
      const confirmFn = httpsCallable(functions, 'confirmCustomerUnavailable');
      const res = await confirmFn({ orderId, tripId: activeTrip.id });
      const data = res.data as { success: boolean; message?: string };
      if (!data.success) {
        failedOrdersRef.current.delete(orderId);
        toast.error(data.message || 'Failed to confirm customer unavailable');
        return;
      }

      toast.error('Delivery marked as failed (Customer Unavailable)');
      setUnavailabilityStartTimes(prev => {
        const next = { ...prev };
        delete next[orderId];
        return next;
      });
    } catch (err: unknown) {
      failedOrdersRef.current.delete(orderId);
      toast.error(getErrorMessage(err) || 'Failed to mark customer unavailable');
    }
  }, [activeTrip]);

  // ── 8. Map Markers ────────────────────────────────────────────────────────
  const mapMarkers = useMemo(() => {
    const markers: any[] = [];
    if (riderLocation) {
      markers.push({
        id: 'rider',
        lat: riderLocation.lat,
        lng: riderLocation.lng,
        title: 'Your Location (Live GPS)',
        isCurrentLocation: true
      });
    }

    pickupStopsList.forEach((stop: any, idx: number) => {
      const v = vendors.find(ven => ven.id === stop.vendorId);
      const lat = v?.location?.lat ?? v?.lat ?? stop.location?.lat;
      const lng = v?.location?.lng ?? v?.lng ?? stop.location?.lng;
      if (lat && lng) {
        markers.push({
          id: `pickup-${stop.vendorId || idx}`,
          lat,
          lng,
          title: `Stop ${idx + 1} (Kitchen): ${v?.kitchen_name || v?.name || 'Kitchen'}`,
          subtitle: stop.status === 'completed' ? 'Picked Up ✓' : (v?.address || v?.location?.address || stop.location?.address || 'Kitchen Pickup')
        });
      }
    });

    remainingDrops.forEach((order, idx) => {
      const addressData = (order as any).address || (order as any).delivery_address;
      const custId = (order as any).customerId || (order as any).user_id || '';
      const cust = customerProfiles[custId];
      if (addressData?.lat && addressData?.lng) {
        markers.push({
          id: `drop-${order.id}`,
          lat: addressData.lat,
          lng: addressData.lng,
          title: `Drop ${totalPickupsCount + idx + 1}: ${cust?.name || 'Customer'}`,
          subtitle: addressData.line1 || 'Customer Doorstep'
        });
      }
    });

    return markers;
  }, [riderLocation, pickupStopsList, vendors, remainingDrops, totalPickupsCount, customerProfiles]);

  const shiftWindow = useMemo(() => {
    const activeSlot = (activeTrip?.slot || (agentOrders[0] as any)?.delivery_slot || (agentOrders[0] as any)?.meal_type || '').toLowerCase();
    if (activeSlot === '11am' || activeSlot === 'lunch' || activeSlot === '1pm') {
      return { slot: 'Lunch Shift', time: '11:00 AM – 1:30 PM', active: true };
    }
    if (activeSlot === '8pm' || activeSlot === 'dinner') {
      return { slot: 'Dinner Shift', time: '7:30 PM – 9:30 PM', active: true };
    }
    const hour = new Date().getHours();
    if (hour < 15) {
      return { slot: 'Lunch Shift', time: '11:00 AM – 1:30 PM', active: hour >= 10 && hour <= 14 };
    }
    return { slot: 'Dinner Shift', time: '7:30 PM – 9:30 PM', active: hour >= 19 && hour <= 22 };
  }, [activeTrip?.slot, agentOrders]);

  if (isMounting) {
    return (
      <div className="space-y-4 max-w-xl mx-auto px-2 animate-pulse pt-2">
        <div className="h-28 bg-white border border-slate-200/80 rounded-3xl" />
        <div className="h-44 bg-white border border-slate-200/80 rounded-3xl" />
        <div className="h-60 bg-white border border-slate-200/80 rounded-3xl" />
      </div>
    );
  }

  if (user && (!isRiderRole || !isVerifiedRider)) {
    return <PendingVerificationScreen role="delivery" />;
  }

  return (
    <div className="space-y-4 pb-28 text-slate-900 max-w-xl mx-auto px-2 sm:px-0">
      {/* ── 1. Top Salary Fleet Partner Card ───────────────────────────────── */}
      <div className="bg-white rounded-3xl p-5 border border-slate-200/80 shadow-[0_4px_24px_rgba(15,23,42,0.04)]">
        <div className="flex items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="relative w-12 h-12 rounded-2xl bg-slate-900 text-white flex items-center justify-center font-black text-sm shadow-xs overflow-hidden shrink-0 border border-slate-100"
              title="Change Profile Photo"
              aria-label="Change profile photo"
            >
              {user?.image ? (
                <Image src={getImageUrl(user.image)} alt={user.name || ''} fill className="object-cover" />
              ) : (
                <span>{((user?.name === 'Test Vendor' ? 'Test Rider' : user?.name) || 'DR').slice(0, 2).toUpperCase()}</span>
              )}
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h1 className="font-black text-base text-slate-900 leading-tight truncate">
                  {user?.name === 'Test Vendor' ? 'Test Rider' : (user?.name || 'Dabzzo Rider')}
                </h1>
                <span className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-emerald-700 bg-emerald-50 px-2.5 py-0.5 rounded-full border border-emerald-200/80 shrink-0">
                  <ShieldCheck className="w-3 h-3" /> Salary Fleet
                </span>
              </div>
              <p className="text-xs font-bold text-slate-500 mt-0.5 truncate flex items-center gap-1.5">
                <Phone className="w-3 h-3 text-slate-400" /> {user?.phone || '+91 99009 90044'} • {user?.vehicle_type || 'Motorcycle'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button 
              onClick={() => handleToggleOnline(!isOnline)}
              className={`text-xs font-black uppercase tracking-wider px-3.5 py-2 rounded-full transition-all flex items-center gap-1.5 shadow-xs active:scale-95 ${
                isOnline 
                  ? 'bg-emerald-600 text-white shadow-emerald-600/20' 
                  : 'bg-slate-100 text-slate-500 border border-slate-200'
              }`}
            >
              <span className={`w-2 h-2 rounded-full ${isOnline ? 'bg-white animate-pulse' : 'bg-slate-400'}`} />
              {isOnline ? 'Online' : 'Offline'}
            </button>
            <button 
              onClick={() => logout()} 
              className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 bg-slate-50 border border-slate-200/80 rounded-2xl transition-colors" 
              title="Log Out"
              aria-label="Log out"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
        <input type="file" ref={fileInputRef} className="hidden" accept="image/*" onChange={handleImageChange} />

        {/* Shift Attendance Status Pill */}
        <div className="bg-slate-50 border border-slate-200/70 rounded-2xl p-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className={`w-2.5 h-2.5 rounded-full ${isOnline ? 'bg-emerald-500' : 'bg-slate-300'}`} />
            <div>
              <p className="text-[11px] font-black uppercase tracking-wider text-slate-900">
                {shiftWindow.slot} ({shiftWindow.time})
              </p>
              <p className="text-[10px] font-semibold text-slate-500">
                {isOnline ? 'Attendance Logged: Present & Standing By ✓' : 'Shift Offline • Toggle online to mark attendance'}
              </p>
            </div>
          </div>
          <span className="text-[10px] font-black uppercase tracking-wider px-2 py-1 rounded-lg bg-white border border-slate-200/80 text-slate-700">
            Fixed Salary
          </span>
        </div>

        {/* Active Progress Bar */}
        {activeTrip && totalTasks > 0 && (
          <div className="mt-3 pt-3 border-t border-slate-100 space-y-1.5">
            <div className="flex items-center justify-between text-xs font-bold text-slate-600">
              <span className="text-[10px] uppercase font-black tracking-wider text-slate-400">Run Progress</span>
              <span className="text-slate-900 font-black">{completedTasks} / {totalTasks} Stops Done ({progressPct}%)</span>
            </div>
            <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
              <div 
                className="h-full bg-brand transition-all duration-500 rounded-full"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* ── 2. Active Stop vs Route Itinerary Segmented Switch ─────────────── */}
      {activeTrip && (
        <div className="bg-white p-1.5 rounded-2xl border border-slate-200/80 shadow-xs flex">
          <button 
            className={`flex-1 py-2.5 px-4 rounded-xl text-xs font-black uppercase tracking-wider transition-all flex items-center justify-center gap-2 ${
              viewTab === 'active' 
                ? 'bg-slate-900 text-white shadow-xs' 
                : 'text-slate-500 hover:text-slate-900'
            }`} 
            onClick={() => setViewTab('active')}
          >
            <Compass className="w-4 h-4" />
            Active Stop
          </button>
          <button 
            className={`flex-1 py-2.5 px-4 rounded-xl text-xs font-black uppercase tracking-wider transition-all flex items-center justify-center gap-2 ${
              viewTab === 'itinerary' 
                ? 'bg-slate-900 text-white shadow-xs' 
                : 'text-slate-500 hover:text-slate-900'
            }`} 
            onClick={() => setViewTab('itinerary')}
          >
            <ListOrdered className="w-4 h-4" />
            Route Sequence ({totalTasks})
          </button>
        </div>
      )}

      {/* ── 3. Content Viewport ────────────────────────────────────────────── */}
      {!isOnline ? (
        <div className="bg-white rounded-3xl p-8 flex flex-col items-center justify-center text-center border border-slate-200/80 shadow-xs space-y-4">
          <div className="w-16 h-16 bg-slate-100 rounded-2xl flex items-center justify-center text-slate-400">
            <Truck size={32} />
          </div>
          <div>
            <h2 className="font-black text-xl text-slate-900 mb-1">You are Offline</h2>
            <p className="text-xs font-medium text-slate-500 max-w-xs mx-auto leading-relaxed">
              Toggle online during shift hours to log your salary attendance and receive assigned kitchen pickup routes.
            </p>
          </div>
          <button 
            onClick={() => handleToggleOnline(true)} 
            className="px-6 py-3.5 bg-brand hover:bg-[#C2410C] text-white font-black text-xs uppercase tracking-wider rounded-2xl shadow-md shadow-brand/20 active:scale-95 transition-all"
          >
            Start Shift / Go Online 🛵
          </button>
        </div>
      ) : currentState === 'IDLE' ? (
        <div className="space-y-3">
        <div className="bg-white rounded-3xl p-8 flex flex-col items-center justify-center text-center border border-slate-200/80 shadow-xs space-y-4">
          <div className="relative">
            <div className="w-16 h-16 bg-amber-50 border border-amber-200 rounded-2xl flex items-center justify-center text-brand">
              <Truck size={32} />
            </div>
            <span className="absolute -top-1 -right-1 w-4 h-4 bg-emerald-500 rounded-full border-2 border-white animate-pulse" />
          </div>
          <div>
            <h2 className="font-black text-xl text-slate-900 mb-1">Standing By for Dispatch</h2>
            <p className="text-xs font-medium text-slate-500 max-w-xs mx-auto leading-relaxed">
              You are online and logged PRESENT for today&apos;s shift. When kitchens finish packing meals, your optimized route will appear here.
            </p>
          </div>
          <div className="bg-slate-50 rounded-2xl p-3 border border-slate-200/70 w-full max-w-xs text-left space-y-1">
            <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Next Meal Slot</p>
            <p className="text-xs font-bold text-slate-900">{shiftWindow.slot} ({shiftWindow.time})</p>
            <p className="text-[10px] text-emerald-600 font-bold">Battery-Smart GPS: Geolocation paused to save battery until run starts</p>
          </div>
        </div>

        {/* Assigned queue — deliveries already assigned to this rider for today */}
        {agentOrders.length > 0 && (
          <div className="bg-white rounded-3xl p-5 border border-slate-200/80 shadow-xs">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-black text-sm text-slate-900 flex items-center gap-2">
                <ListOrdered className="w-4 h-4 text-brand" /> Your Assigned Deliveries
              </h3>
              <div className="flex items-center gap-1.5 shrink-0">
                {(() => {
                  const done = agentOrders.filter(o => o.status === 'delivered').length;
                  const failed = agentOrders.filter(o => o.status === 'failed').length;
                  const inFlight = agentOrders.length - done - failed;
                  return (
                    <>
                      <span className="text-[9px] font-black uppercase tracking-wider px-2 py-1 rounded-full bg-amber-100 text-amber-700">
                        {inFlight} to go
                      </span>
                      <span className="text-[9px] font-black uppercase tracking-wider px-2 py-1 rounded-full bg-emerald-100 text-emerald-700">
                        {done} done
                      </span>
                      {failed > 0 && (
                        <span className="text-[9px] font-black uppercase tracking-wider px-2 py-1 rounded-full bg-red-100 text-red-700">
                          {failed} failed
                        </span>
                      )}
                    </>
                  );
                })()}
              </div>
            </div>
            <div className="space-y-2.5">
              {(() => {
                // Queue in driver-ready priority order: furthest along first,
                // terminal statuses (delivered/cancelled/failed) pushed to the
                // bottom so the rider always sees the NEXT stop on top.
                const queueOrderRank: Record<string, number> = {
                  out_for_delivery: 1,
                  picked_up: 2,
                  rider_en_route_pickup: 3,
                  picking_up: 4,
                  rider_assigned: 5,
                  vendor_ready: 6,
                  ready: 7,
                  dispatched: 8,
                  preparing: 9,
                  vendor_preparing: 10,
                  vendor_notified: 11,
                  cooking: 12,
                  created: 13,
                  pending: 14,
                };
                const sortedQueue = [...agentOrders].sort((a, b) => {
                  const aTerminal = ['delivered', 'failed', 'cancelled'].includes(a.status) ? 1 : 0;
                  const bTerminal = ['delivered', 'failed', 'cancelled'].includes(b.status) ? 1 : 0;
                  if (aTerminal !== bTerminal) return aTerminal - bTerminal;
                  return (queueOrderRank[a.status] ?? 20) - (queueOrderRank[b.status] ?? 20);
                });
                const firstNext = sortedQueue.find(o => !['delivered', 'failed', 'cancelled'].includes(o.status));

                return sortedQueue.map((order: any) => {
                const custId = order.customerId || order.user_id || '';
                const cust = customerProfiles[custId];
                const addressData = order.address || order.delivery_address;
                const lat = addressData?.lat;
                const lng = addressData?.lng;
                const phone = cust?.phone || order.customerPhone;
                const isDone = order.status === 'delivered';
                const isInFlight = order.status !== 'delivered' && order.status !== 'failed' && order.status !== 'cancelled';
                const isNext = !!firstNext && firstNext.id === order.id;
                const mapHref = lat && lng
                  ? `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`
                  : (addressData?.line1 || cust?.address)
                    ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addressData?.line1 || cust?.address || '')}`
                    : null;

                return (
                  <div key={`queue-${order.id}`} className={`rounded-2xl border p-3.5 flex items-start gap-3 ${isDone ? 'bg-slate-50/70 border-slate-200/60 opacity-70' : isNext ? 'bg-brand/[0.04] border-brand/40 ring-1 ring-brand/20' : 'bg-white border-slate-200/80'}`}>
                    <div className={`w-9 h-9 rounded-xl flex items-center justify-center text-[10px] font-black shrink-0 ${isDone ? 'bg-emerald-100 text-emerald-700' : isNext ? 'bg-brand text-white' : 'bg-slate-900 text-white'}`}>
                      {isDone ? <CheckCircle2 className="w-4 h-4" /> : '#'.concat(order.id?.slice(-5) || '—')}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-black text-[13px] text-slate-900 leading-tight truncate">
                          {cust?.name || `Customer ${custId.slice(-4)}`}
                        </p>
                        <span className={`text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-full ${isDone ? 'bg-emerald-100 text-emerald-700' : isInFlight ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>
                          {isDone ? 'Delivered' : isInFlight ? order.status?.replace(/_/g, ' ') : order.status}
                        </span>
                        {isNext && (
                          <span className="text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-brand text-white">
                            Next
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-slate-500 font-medium truncate mt-0.5">
                        {addressData?.line1 || cust?.address || 'Doorstep Address'}
                      </p>
                      <p className="text-[10px] font-mono text-slate-400 mt-0.5">
                        #{order.id} · {order.meal_type || order.meal?.type || order.scheduledSlot || '—'}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {phone && (
                        <a href={`tel:${phone}`} aria-label="Call customer" className="w-8 h-8 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center justify-center active:scale-95 transition-all" title="Call Customer">
                          <Phone className="w-3.5 h-3.5" />
                        </a>
                      )}
                      {mapHref && (
                        <a href={mapHref} target="_blank" rel="noopener noreferrer" aria-label="Open in Google Maps" className="w-8 h-8 rounded-lg bg-blue-50 text-blue-700 border border-blue-200 flex items-center justify-center active:scale-95 transition-all" title="Open in Google Maps">
                          <Navigation className="w-3.5 h-3.5" />
                        </a>
                      )}
                    </div>
                  </div>
                );
                });
              })()}
            </div>
          </div>
        )}
        </div>
      ) : viewTab === 'itinerary' ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between px-1">
            <h3 className="font-black text-sm text-slate-900 flex items-center gap-2">
              <ListOrdered className="w-4 h-4 text-brand" /> Optimized Route Itinerary
            </h3>
            <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">
              Pickups First ➔ Doorstep Next
            </span>
          </div>

          <div className="space-y-3">
            {pickupStopsList.map((stop: any, idx: number) => {
              const v = vendors.find(ven => ven.id === stop.vendorId);
              const isDone = stop.status === 'completed';
              const isCurrent = currentState === 'PICKUP' && nextPickup?.vendorId === stop.vendorId;
              const lat = v?.location?.lat ?? v?.lat ?? stop.location?.lat;
              const lng = v?.location?.lng ?? v?.lng ?? stop.location?.lng;
              const kitchenAddress = v?.address || v?.location?.address || stop.location?.address || 'Kitchen Address on record';
              const phone = stop.vendorPhone || v?.phone;
              const isNavigatingThis = navigatingVendorId === stop.vendorId;

              return (
                <div 
                  key={`itinerary-pickup-${idx}`}
                  className={`bg-white rounded-3xl p-4 border transition-all ${
                    isCurrent 
                      ? 'border-brand ring-2 ring-brand/20 shadow-md' 
                      : isDone 
                      ? 'border-slate-200/60 opacity-60 bg-slate-50/50' 
                      : 'border-slate-200/80 shadow-xs'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3 min-w-0 flex-1">
                      <div className={`w-10 h-10 rounded-2xl flex items-center justify-center text-sm font-black shrink-0 ${
                        isDone ? 'bg-emerald-100 text-emerald-700' : 'bg-brand/10 text-brand'
                      }`}>
                        {isDone ? <CheckCircle2 className="w-5 h-5" /> : `P${idx + 1}`}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-black uppercase tracking-wider text-brand">Kitchen Pickup</span>
                          {isCurrent && <span className="text-[9px] font-black uppercase tracking-wider bg-brand text-white px-2 py-0.2 rounded-full">Current Stop</span>}
                        </div>
                        <h4 className="font-black text-sm text-slate-900 leading-tight truncate mt-0.5">
                          {v?.kitchen_name || v?.name || `Kitchen ${stop.vendorId?.slice(-4)}`}
                        </h4>
                        <p className="text-xs text-slate-500 font-medium truncate mt-0.5">
                          {kitchenAddress}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      {phone && (
                        <a 
                          href={`tel:${phone}`}
                          className="w-9 h-9 rounded-xl bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center justify-center active:scale-95 transition-all shadow-xs"
                          title="Call Kitchen"
                          aria-label="Call kitchen"
                        >
                          <Phone className="w-4 h-4" />
                        </a>
                      )}
                      <button
                        type="button"
                        onClick={() => handleNavigateToKitchen(stop.vendorId, lat, lng, kitchenAddress)}
                        disabled={isNavigatingThis}
                        className="w-9 h-9 rounded-xl bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 flex items-center justify-center active:scale-95 transition-all shadow-xs cursor-pointer disabled:opacity-75"
                        title="Navigate to Kitchen"
                        aria-label="Navigate to kitchen"
                      >
                        {isNavigatingThis ? (
                          <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
                        ) : (
                          <Navigation className="w-4 h-4" />
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}

            {agentOrders.map((order: any, idx: number) => {
              const custId = order.customerId || order.user_id || '';
              const cust = customerProfiles[custId];
              const addressData = order.address || order.delivery_address;
              const isDone = order.status === 'delivered';
              const isCurrent = currentState === 'DELIVERY' && currentDropOrder?.id === order.id;
              const lat = addressData?.lat;
              const lng = addressData?.lng;
              const phone = cust?.phone || order.customerPhone;

              return (
                <div 
                  key={`itinerary-drop-${order.id}`}
                  className={`bg-white rounded-3xl p-4 border transition-all ${
                    isCurrent 
                      ? 'border-brand ring-2 ring-brand/20 shadow-md' 
                      : isDone 
                      ? 'border-slate-200/60 opacity-60 bg-slate-50/50' 
                      : 'border-slate-200/80 shadow-xs'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3 min-w-0 flex-1">
                      <div className={`w-10 h-10 rounded-2xl flex items-center justify-center text-sm font-black shrink-0 ${
                        isDone ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-900 text-white'
                      }`}>
                        {isDone ? <CheckCircle2 className="w-5 h-5" /> : `D${idx + 1}`}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">Customer Drop-off</span>
                          {isCurrent && <span className="text-[9px] font-black uppercase tracking-wider bg-brand text-white px-2 py-0.2 rounded-full">Current Stop</span>}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <h4 className="font-black text-sm text-slate-900 leading-tight truncate">
                            {cust?.name || `Customer ${custId.slice(-4)}`}
                          </h4>
                          <span className="text-[10px] font-mono font-black bg-slate-900 text-amber-400 px-2 py-0.5 rounded-md tracking-wider">
                            {generateBoxTag({
                              customerName: cust?.name,
                              vendorName: 'Kitchen',
                              sequenceNumber: idx + 1,
                              planType: order.plan_type || 'weekly',
                              cycleNumber: order.cycle_number || 1
                            })}
                          </span>
                          <span className="text-[9px] font-mono font-black bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded-md tracking-tight">
                            #{order.id?.slice(-8)}
                          </span>
                        </div>
                        <p className="text-xs text-slate-500 font-medium truncate mt-0.5">
                          {addressData?.line1 || cust?.address || 'Doorstep Address'}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      {phone && (
                        <a 
                          href={`tel:${phone}`}
                          className="w-9 h-9 rounded-xl bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center justify-center active:scale-95 transition-all shadow-xs"
                          title="Call Customer"
                          aria-label="Call customer"
                        >
                          <Phone className="w-4 h-4" />
                        </a>
                      )}
                      {lat && lng ? (
                        <a 
                          href={`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="w-9 h-9 rounded-xl bg-blue-50 text-blue-700 border border-blue-200 flex items-center justify-center active:scale-95 transition-all shadow-xs"
                          title="Navigate"
                          aria-label="Navigate to customer"
                        >
                          <Navigation className="w-4 h-4" />
                        </a>
                      ) : (addressData?.line1 || cust?.address) ? (
                        <a 
                          href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addressData?.line1 || cust?.address || '')}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="w-9 h-9 rounded-xl bg-blue-50 text-blue-700 border border-blue-200 flex items-center justify-center active:scale-95 transition-all shadow-xs"
                          title="Navigate"
                          aria-label="Navigate to customer"
                        >
                          <Navigation className="w-4 h-4" />
                        </a>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : currentState === 'PICKUP' && nextPickup ? (
        (() => {
          const v = vendors.find(ven => ven.id === nextPickup.vendorId);
          const kitchenName = v?.kitchen_name || v?.name || `Kitchen ${nextPickup.vendorId?.slice(-4)}`;
          const kitchenAddress = v?.address || v?.location?.address || nextPickup.location?.address || 'Address on record with Dabzzo';
          const lat = v?.location?.lat ?? v?.lat ?? nextPickup.location?.lat;
          const lng = v?.location?.lng ?? v?.lng ?? nextPickup.location?.lng;
          const phone = nextPickup.vendorPhone || v?.phone;
          const expectedCount = nextPickup.expectedTiffinCount || agentOrders.length || 1;
          const isNavigatingThis = navigatingVendorId === nextPickup.vendorId;

          return (
            <div className="bg-white border border-slate-200/80 rounded-3xl p-5 shadow-[0_4px_24px_rgba(15,23,42,0.04)] space-y-4 animate-fade-in">
              <div className="flex items-center justify-between">
                <span className="px-3 py-1 bg-amber-50 text-brand border border-amber-200/80 text-[10px] font-black uppercase tracking-wider rounded-full flex items-center gap-1.5">
                  <Store className="w-3.5 h-3.5" /> Stop 1: Kitchen Pickup
                </span>
                <span className="text-xs font-black text-slate-900">
                  {completedPickupsCount + 1} of {totalPickupsCount} Kitchens
                </span>
              </div>

              <div>
                <h2 className="font-black text-xl text-slate-900 leading-tight">
                  {kitchenName}
                </h2>
                <p className="text-xs text-slate-500 font-medium mt-1 leading-relaxed">
                  {kitchenAddress}
                </p>
              </div>

              <div className="bg-slate-50 border border-slate-200/60 rounded-2xl p-3.5 flex items-center justify-between">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Total Tiffins to Collect</p>
                  <p className="font-black text-base text-slate-900 mt-0.5">{expectedCount} Packed Tiffins</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-emerald-50 text-emerald-800 border border-emerald-200 text-xs font-bold">
                    <VegIcon size={14} /> <span>Veg</span>
                  </span>
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-rose-50 text-rose-800 border border-rose-200 text-xs font-bold">
                    <NonVegIcon size={14} /> <span>Non-Veg</span>
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                {phone ? (
                  <a 
                    href={`tel:${phone}`}
                    className="py-3.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-2xl text-xs font-black uppercase tracking-wider flex items-center justify-center gap-2 shadow-sm shadow-emerald-600/20 active:scale-95 transition-all"
                  >
                    <Phone size={16} /> Call Kitchen
                  </a>
                ) : (
                  <button disabled className="py-3.5 bg-slate-100 text-slate-400 rounded-2xl text-xs font-black uppercase tracking-wider flex items-center justify-center gap-2">
                    <Phone size={16} /> No Phone
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => handleNavigateToKitchen(nextPickup.vendorId, lat, lng, kitchenAddress)}
                  disabled={isNavigatingThis}
                  className="py-3.5 bg-blue-600 hover:bg-blue-700 text-white rounded-2xl text-xs font-black uppercase tracking-wider flex items-center justify-center gap-2 shadow-sm shadow-blue-600/20 active:scale-95 transition-all cursor-pointer disabled:opacity-80"
                >
                  {isNavigatingThis ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <Navigation size={16} />
                  )}
                  <span>Navigate</span>
                </button>
              </div>

              <div className="bg-amber-50/70 border border-amber-200/80 rounded-2xl p-4 space-y-3">
                {pickupStep === 'otp' ? (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-black uppercase tracking-widest text-brand">
                        Enter 4-Digit Kitchen Pickup OTP
                      </span>
                      <span className="text-[10px] font-bold text-slate-400">Ask Chef</span>
                    </div>
                    <p className="text-xs text-slate-600 font-medium leading-relaxed">
                      Enter the 4-digit code shown on the vendor kitchen terminal to verify meal handover.
                    </p>
                    <div className="flex items-center gap-2">
                      <input 
                        type="text" 
                        maxLength={4}
                        value={vendorOTP}
                        onChange={(e) => setVendorOTP(e.target.value.replace(/\D/g, ''))}
                        placeholder="• • • •"
                        className="flex-1 text-center tracking-[0.4em] text-2xl font-black py-2.5 bg-white border border-amber-300 rounded-2xl focus:outline-none focus:border-brand text-slate-900"
                      />
                      <button
                        disabled={vendorOTP.length !== 4 || verifyingVendorOTP}
                        onClick={handleVerifyVendorOTP}
                        className="py-3 px-5 bg-brand hover:bg-[#C2410C] disabled:opacity-50 text-white font-black text-xs uppercase tracking-wider rounded-2xl shadow-sm shadow-brand/20 transition-all flex items-center justify-center gap-1.5 shrink-0 active:scale-95"
                      >
                        {verifyingVendorOTP ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Verify Code'}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-black uppercase tracking-widest text-emerald-700">
                        Confirm Tiffins Received
                      </span>
                      <span className="text-[10px] font-bold text-slate-400">Expected: {vendorDeclaredCount}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <input 
                        type="number"
                        value={riderConfirmedCount}
                        onChange={(e) => setRiderConfirmedCount(e.target.value)}
                        className="w-24 text-center text-xl font-black py-2.5 bg-white border border-emerald-300 rounded-2xl focus:outline-none focus:border-emerald-600 text-slate-900"
                      />
                      <button
                        disabled={!riderConfirmedCount || verifyingVendorOTP}
                        onClick={handleConfirmPickupCount}
                        className="flex-1 py-3 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-black text-xs uppercase tracking-wider rounded-2xl shadow-sm shadow-emerald-600/20 transition-all flex items-center justify-center gap-2 active:scale-95"
                      >
                        {verifyingVendorOTP ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Confirm & Depart 🚀'}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          );
        })()
      ) : currentState === 'DELIVERY' && currentDropOrder ? (
        (() => {
          const custId = currentDropOrder.customerId || currentDropOrder.user_id || '';
          const cust = customerProfiles[custId];
          const addressData = currentDropOrder.address || currentDropOrder.delivery_address;
          const phone = cust?.phone || currentDropOrder.customerPhone;
          const mealType = currentDropOrder.meal_type || currentDropOrder.meal?.type || 'Lunch';
          const lat = addressData?.lat;
          const lng = addressData?.lng;

          return (
            <div className="bg-white border border-slate-200/80 rounded-3xl p-5 shadow-[0_4px_24px_rgba(15,23,42,0.04)] space-y-4 animate-fade-in">
              <div className="flex items-center justify-between">
                <span className="px-3 py-1 bg-slate-900 text-white text-[10px] font-black uppercase tracking-wider rounded-full flex items-center gap-1.5">
                  <PackageOpen className="w-3.5 h-3.5" /> Next Drop: #{completedDropsCount + 1}
                </span>
                <span className="text-xs font-black text-slate-900">
                  {completedDropsCount + 1} of {totalDropsCount} Deliveries
                </span>
              </div>

              <div className="text-[10px] font-mono font-bold text-slate-400">
                Order #{currentDropOrder.id}
              </div>

              <div>
                <div className="flex items-center justify-between gap-2">
                  <h2 className="font-black text-xl text-slate-900 leading-tight">
                    {cust?.name || `Customer ${custId.slice(-4)}`}
                  </h2>
                  <span className="text-xs font-black uppercase tracking-wider bg-slate-100 text-slate-700 px-2.5 py-1 rounded-xl">
                    {mealType}
                  </span>
                </div>
                <p className="text-xs text-slate-500 font-medium mt-1 leading-relaxed">
                  {addressData?.line1 || cust?.address || 'Doorstep delivery address on record'}
                </p>
                {addressData?.landmark && (
                  <p className="text-xs text-brand font-bold mt-1 flex items-center gap-1">
                    <MapPin className="w-3.5 h-3.5" /> Landmark: {addressData.landmark}
                  </p>
                )}
              </div>

              {/* Tiffin Box Tag Banner */}
              <div className="bg-slate-900 text-white rounded-2xl p-4 flex items-center justify-between border border-slate-800 shadow-md">
                <div>
                  <span className="text-[10px] font-black uppercase tracking-wider text-amber-400">
                    🏷️ Match Tiffin Tag From Bag
                  </span>
                  <div className="text-2xl font-mono font-black text-white tracking-widest mt-0.5">
                    {generateBoxTag({
                      customerName: cust?.name,
                      vendorName: 'Kitchen',
                      sequenceNumber: completedDropsCount + 1,
                      planType: currentDropOrder.plan_type || 'weekly',
                      cycleNumber: currentDropOrder.cycle_number || 1
                    })}
                  </div>
                  <p className="text-[10px] font-semibold text-slate-400 mt-0.5">
                    Hand over this exact tagged box to customer
                  </p>
                </div>
                <DietaryBadge type={currentDropOrder.meal_type === 'non_veg' ? 'non_veg' : 'veg'} size={18} />
              </div>

              {/* 1-Tap Action Buttons */}
              <div className="grid grid-cols-2 gap-3">
                {phone ? (
                  <a 
                    href={`tel:${phone}`}
                    className="py-3.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-2xl text-xs font-black uppercase tracking-wider flex items-center justify-center gap-2 shadow-sm shadow-emerald-600/20 active:scale-95 transition-all"
                  >
                    <Phone size={16} /> Call Customer
                  </a>
                ) : (
                  <button disabled className="py-3.5 bg-slate-100 text-slate-400 rounded-2xl text-xs font-black uppercase tracking-wider flex items-center justify-center gap-2">
                    <Phone size={16} /> No Phone
                  </button>
                )}

                {(() => {
                  const isFallbackCoord = (!lat && !lng) || (lat === 0 && lng === 0) || (lat === 18.5204 && lng === 73.8567) || (lat === 21.1458 && lng === 79.0882);
                  const textAddr = addressData?.line1 || cust?.address;

                  if (textAddr && isFallbackCoord) {
                    return (
                      <a 
                        href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(textAddr)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="py-3.5 bg-blue-600 hover:bg-blue-700 text-white rounded-2xl text-xs font-black uppercase tracking-wider flex items-center justify-center gap-2 shadow-sm shadow-blue-600/20 active:scale-95 transition-all"
                      >
                        <Navigation size={16} /> Navigate
                      </a>
                    );
                  }

                  if (lat && lng && !isFallbackCoord) {
                    return (
                      <a 
                        href={`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="py-3.5 bg-blue-600 hover:bg-blue-700 text-white rounded-2xl text-xs font-black uppercase tracking-wider flex items-center justify-center gap-2 shadow-sm shadow-blue-600/20 active:scale-95 transition-all"
                      >
                        <Navigation size={16} /> Navigate
                      </a>
                    );
                  }

                  if (textAddr) {
                    return (
                      <a 
                        href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(textAddr)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="py-3.5 bg-blue-600 hover:bg-blue-700 text-white rounded-2xl text-xs font-black uppercase tracking-wider flex items-center justify-center gap-2 shadow-sm shadow-blue-600/20 active:scale-95 transition-all"
                      >
                        <Navigation size={16} /> Navigate
                      </a>
                    );
                  }

                  return null;
                })()}
              </div>

              {/* Direct In-Card Customer OTP Verification */}
              <div className="bg-emerald-50/80 border border-emerald-200/80 rounded-2xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-black uppercase tracking-widest text-emerald-800">
                    Customer Doorstep OTP PIN
                  </span>
                  <span className="text-[10px] font-bold text-slate-400">Ask Customer</span>
                </div>
                <p className="text-xs text-slate-600 font-medium leading-relaxed">
                  Ask customer for the 4-digit Delivery PIN shown on their live tracking screen.
                </p>
                <div className="flex items-center gap-2">
                  <input 
                    type="text" 
                    maxLength={4}
                    value={dropoffOTP}
                    onChange={(e) => setDropoffOTP(e.target.value.replace(/\D/g, ''))}
                    placeholder="• • • •"
                    className="flex-1 text-center tracking-[0.4em] text-2xl font-black py-2.5 bg-white border border-emerald-300 rounded-2xl focus:outline-none focus:border-emerald-600 text-slate-900"
                  />
                  <button
                    disabled={dropoffOTP.length !== 4 || verifyingDropoffOTP}
                    onClick={handleVerifyDropoffOTP}
                    className="py-3 px-5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-black text-xs uppercase tracking-wider rounded-2xl shadow-sm shadow-emerald-600/20 transition-all flex items-center justify-center gap-1.5 shrink-0 active:scale-95"
                  >
                    {verifyingDropoffOTP ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Complete ✓'}
                  </button>
                </div>
              </div>

              {/* Customer Not Answering Timer */}
              <div>
                {(() => {
                  const serverUnavail = (currentDropOrder as any)?.unavailability_started_at;
                  const start = unavailabilityStartTimes[currentDropOrder.id] || (
                    serverUnavail?.toMillis ? serverUnavail.toMillis() :
                    serverUnavail?.seconds ? serverUnavail.seconds * 1000 :
                    serverUnavail ? new Date(serverUnavail).getTime() : null
                  );

                  if (!start) {
                    return (
                      <button
                        onClick={() => handleStartUnavailability(currentDropOrder.id)}
                        className="w-full py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition-all bg-slate-50 text-slate-500 hover:text-slate-700 hover:bg-slate-100 border border-slate-200/60"
                      >
                        Customer Not Answering (Start 10m Countdown)
                      </button>
                    );
                  }

                  const remaining = Math.max(0, 600 - Math.floor((nowTick - start) / 1000));
                  const m = Math.floor(remaining / 60);
                  const s = remaining % 60;

                  if (remaining > 0) {
                    return (
                      <button
                        disabled
                        className="w-full py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-2 bg-amber-50 text-amber-700 border border-amber-200 cursor-not-allowed opacity-90"
                      >
                        <span className="w-2 h-2 rounded-full bg-amber-500 animate-ping shrink-0" />
                        Waiting for Customer ({m}:{s.toString().padStart(2, '0')} remaining)
                      </button>
                    );
                  }

                  return (
                    <button
                      onClick={() => handleConfirmCustomerUnavailable(currentDropOrder.id)}
                      className="w-full py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition-all bg-rose-600 hover:bg-rose-700 text-white shadow-sm shadow-rose-600/20 active:scale-95"
                    >
                      Confirm Customer Unavailable (Timer Expired)
                    </button>
                  );
                })()}
              </div>
            </div>
          );
        })()
      ) : null}

      {/* ── 4. Live Route GPS Map ──────────────────────────────────────────── */}
      {isOnline && (
        <div className="bg-white rounded-3xl p-4 border border-slate-200/80 shadow-[0_4px_24px_rgba(15,23,42,0.04)] space-y-3">
          <div className="flex items-center justify-between px-1">
            <h3 className="font-black text-sm text-slate-900 flex items-center gap-2">
              <Navigation className="w-4 h-4 text-brand" /> Live Route Map
            </h3>
            <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">
              {activeTrip ? 'GPS Navigation Active' : 'Fleet Standing By'}
            </span>
          </div>

          <div className="rounded-2xl overflow-hidden border border-slate-100 h-64">
            <DeliveryMap markers={mapMarkers} />
          </div>
        </div>
      )}
    </div>
  );
}
