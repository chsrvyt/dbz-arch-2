import * as functions from 'firebase-functions/v1';
import * as admin from 'firebase-admin';

// Import the server-side referral code generator (self-contained package).
import { generateReferralCodeForFunctions } from './referralFunctions';

// Triggered when a new user signs up
export const onUserCreate = functions.auth.user().onCreate(async (user) => {
  try {
    // Default to 'customer' role
    const customClaims = { role: 'customer' };
    
    // Set custom claim
    await admin.auth().setCustomUserClaims(user.uid, customClaims);
    
    // Also initialize the user document in Firestore for client-side display if needed
    await admin.firestore().collection('users').doc(user.uid).set({
      email: user.email,
      role: 'customer',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    // Allocate a unique referral code for the new user (best-effort).
    let referralCode = '';
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = generateReferralCodeForFunctions();
      try {
        await admin.firestore().collection('referral_codes').doc(candidate).set({
          user_id: user.uid,
          created_at: admin.firestore.FieldValue.serverTimestamp(),
        });
        referralCode = candidate;
        break;
      } catch {
        // collision — try another
      }
    }
    if (referralCode) {
      await admin.firestore().collection('users').doc(user.uid).set(
        { referral_code: referralCode },
        { merge: true }
      );
    }

    functions.logger.info(`Successfully set default 'customer' role for user ${user.uid}`);
  } catch (error) {
    functions.logger.error(`Failed to set custom claim for user ${user.uid}:`, error);
  }
});

// Callable function for Admins to update user roles
export const setUserRole = functions.https.onCall(async (data, context) => {
  // 1. Check if caller is authenticated
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'You must be signed in.');
  }

  // 2. Check if caller is an admin
  if (context.auth.token.role !== 'admin') {
    const userDoc = await admin.firestore().collection('users').doc(context.auth.uid).get();
    if (!userDoc.exists || userDoc.data()?.role !== 'admin') {
      throw new functions.https.HttpsError('permission-denied', 'Only admins can set user roles.');
    }
  }

  const { uid, role } = data;

  if (!uid || !role) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing uid or role.');
  }

  const allowedRoles = ['customer', 'vendor', 'delivery_agent', 'admin'];
  if (!allowedRoles.includes(role)) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid role provided.');
  }

  if (role === 'admin') {
    throw new functions.https.HttpsError('permission-denied', 'Admin role can only be provisioned via the Firebase Console.');
  }

  try {
    // 3. Set the custom claim on Firebase Auth
    await admin.auth().setCustomUserClaims(uid, { role });

    // 4. Keep Firestore in sync
    await admin.firestore().collection('users').doc(uid).set({
      role: role,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    functions.logger.info(`Admin ${context.auth.uid} successfully updated user ${uid} to role: ${role}`);
    
    return { success: true, message: `Successfully updated user role to ${role}` };
  } catch (error) {
    functions.logger.error(`Error setting user role for ${uid}:`, error);
    throw new functions.https.HttpsError('internal', 'Failed to update user role.');
  }
});
