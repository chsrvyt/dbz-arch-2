'use client';

import Image from 'next/image';
import { motion } from 'framer-motion';
import { User, ChefHat, Bike } from 'lucide-react';

export function FeaturesBenefits() {
  return (
    <section id="why-choose-us" className="py-24 bg-white border-b border-slate-100">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-3xl mx-auto mb-16">
          <h2 className="text-brand font-bold tracking-wide uppercase text-sm mb-3">Why Choose Us</h2>
          <h3 className="text-3xl md:text-4xl font-black text-slate-900 leading-tight">
            Why people choose Dabzzo.
          </h3>
        </div>

        <div className="grid lg:grid-cols-3 gap-8">
          
          {/* For Customers */}
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
            className="bg-slate-50 rounded-3xl p-6 border border-slate-100 flex flex-col"
          >
            <div className="w-full h-48 bg-slate-200 rounded-2xl mb-6 overflow-hidden relative">
              <Image
                src="/dabzzo_tiffin_box.webp"
                alt="Fresh Tiffin Box"
                fill
                className="object-cover hover:scale-105 transition-transform duration-500"
                sizes="(max-width: 768px) 100vw, 33vw"
              />
            </div>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-brand/10 text-brand rounded-full flex items-center justify-center shrink-0">
                <User className="w-5 h-5" />
              </div>
              <h4 className="text-xl font-bold text-slate-900">For Customers</h4>
            </div>
            <ul className="space-y-3 flex-1">
              <li className="flex items-start gap-2 text-sm text-slate-600">
                <span className="text-brand font-bold mt-0.5">•</span> Pause or swap meals on the go.
              </li>
              <li className="flex items-start gap-2 text-sm text-slate-600">
                <span className="text-brand font-bold mt-0.5">•</span> Real-time delivery tracking.
              </li>
              <li className="flex items-start gap-2 text-sm text-slate-600">
                <span className="text-brand font-bold mt-0.5">•</span> Get credits when you skip a meal.
              </li>
              <li className="flex items-start gap-2 text-sm text-slate-600">
                <span className="text-brand font-bold mt-0.5">•</span> Everyday food that doesn&apos;t feel heavy.
              </li>
            </ul>
          </motion.div>

          {/* For Kitchen Partners — anchor target for #kitchen-partners */}
          <motion.div 
            id="kitchen-partners"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.15, duration: 0.5 }}
            className="bg-slate-50 rounded-3xl p-6 border border-slate-100 flex flex-col"
          >
            <div className="w-full h-48 bg-emerald-100 rounded-2xl mb-6 overflow-hidden relative">
              <Image
                src="/dabzzo_kitchen_partner.webp"
                alt="Local Indian Kitchen"
                fill
                className="object-cover hover:scale-105 transition-transform duration-500"
                sizes="(max-width: 768px) 100vw, 33vw"
              />
            </div>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-emerald-500/10 text-emerald-600 rounded-full flex items-center justify-center shrink-0">
                <ChefHat className="w-5 h-5" />
              </div>
              <h4 className="text-xl font-bold text-slate-900">For Kitchen Partners</h4>
            </div>
            <ul className="space-y-3 flex-1">
              <li className="flex items-start gap-2 text-sm text-slate-600">
                <span className="text-brand font-bold mt-0.5">•</span> Predictable daily order volume.
              </li>
              <li className="flex items-start gap-2 text-sm text-slate-600">
                <span className="text-brand font-bold mt-0.5">•</span> No marketing costs.
              </li>
              <li className="flex items-start gap-2 text-sm text-slate-600">
                <span className="text-brand font-bold mt-0.5">•</span> Weekly automated payouts.
              </li>
              <li className="flex items-start gap-2 text-sm text-slate-600">
                <span className="text-brand font-bold mt-0.5">•</span> You cook, we deliver.
              </li>
            </ul>
          </motion.div>

          {/* For Delivery Partners — anchor target for #delivery-partners */}
          <motion.div 
            id="delivery-partners"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.3, duration: 0.5 }}
            className="bg-slate-50 rounded-3xl p-6 border border-slate-100 flex flex-col"
          >
            <div className="w-full h-48 bg-amber-100 rounded-2xl mb-6 overflow-hidden relative">
              <Image
                src="/dabzzo_delivery_rider.webp"
                alt="Dabzzo Delivery Rider"
                fill
                className="object-cover hover:scale-105 transition-transform duration-500"
                sizes="(max-width: 768px) 100vw, 33vw"
              />
            </div>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-amber-500/10 text-amber-600 rounded-full flex items-center justify-center shrink-0">
                <Bike className="w-5 h-5" />
              </div>
              <h4 className="text-xl font-bold text-slate-900">For Delivery Partners</h4>
            </div>
            <ul className="space-y-3 flex-1">
              <li className="flex items-start gap-2 text-sm text-slate-600">
                <span className="text-brand font-bold mt-0.5">•</span> Fixed daily delivery routes.
              </li>
              <li className="flex items-start gap-2 text-sm text-slate-600">
                <span className="text-brand font-bold mt-0.5">•</span> Predictable shifts (Lunch &amp; Dinner).
              </li>
              <li className="flex items-start gap-2 text-sm text-slate-600">
                <span className="text-brand font-bold mt-0.5">•</span> Clear earnings per delivery.
              </li>
              <li className="flex items-start gap-2 text-sm text-slate-600">
                <span className="text-brand font-bold mt-0.5">•</span> Easy-to-use partner app.
              </li>
            </ul>
          </motion.div>

        </div>
      </div>
    </section>
  );
}
