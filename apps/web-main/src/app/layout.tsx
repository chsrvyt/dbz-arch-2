import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Toaster } from 'react-hot-toast';
import { AuthProvider } from '@/lib/auth';
import { PermissionGuard } from '@/components/shared/PermissionGuard';
import { PageTransition } from '@/components/ui/PageTransition';
import { UserAppShell } from '@/components/UserAppShell';

export const viewport: Viewport = {
  themeColor: '#E68A00',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  // Required for env(safe-area-inset-*) to report anything but 0 on notched
  // iPhones. globals.css already uses those insets in ~50 places; without
  // viewport-fit=cover they all silently collapse to the fallback and content
  // sits under the notch and the home indicator. This app ships via Capacitor,
  // so that is a real device, not a hypothetical.
  viewportFit: 'cover',
};

export const metadata: Metadata = {
  manifest: '/manifest.json',
  title: 'Dabzzo | Premium Food Subscriptions',
  description: 'Order and manage daily meal subscriptions from top home chefs and kitchens',
  icons: {
    icon: '/icon.png',
    shortcut: '/favicon.ico',
    apple: '/icon.png',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // suppressHydrationWarning applies to THIS element's attributes only,
    // one level deep -- it does not hide real content mismatches. Browser
    // extensions (QuillBot writes data-qb-installed, Grammarly and password
    // managers do similar) mutate <html> before React hydrates, which React
    // otherwise reports as a hydration error the app cannot fix.
    <html lang="en" data-scroll-behavior="smooth" suppressHydrationWarning>
      <body className="bg-[#FEFCE8] text-slate-900 antialiased font-sans">
        <Toaster position="top-center" />
        <PermissionGuard />
        <AuthProvider>
          <PageTransition>
            <UserAppShell>
              {children}
            </UserAppShell>
          </PageTransition>
        </AuthProvider>
      </body>
    </html>
  );
}
