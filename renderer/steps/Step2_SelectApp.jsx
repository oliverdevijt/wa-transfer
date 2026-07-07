import React from 'react';
import { MessageCircle, Briefcase } from 'lucide-react';

export default function Step2_SelectApp({ next }) {
  const select = (appId) => next({ appId });

  return (
    <div className="p-8 max-w-xl mx-auto">
      <h2 className="text-2xl font-bold text-white mb-2">Which app are you transferring?</h2>
      <p className="text-slate-400 mb-8">Select the WhatsApp app installed on your Android phone.</p>

      <div className="space-y-4">
        <button
          onClick={() => select('com.whatsapp')}
          className="w-full flex items-center gap-4 bg-slate-800 hover:bg-slate-700 border border-slate-700 hover:border-green-500 rounded-xl p-5 transition-all group"
        >
          <div className="w-12 h-12 bg-green-500 rounded-xl flex items-center justify-center">
            <MessageCircle className="w-7 h-7 text-white" />
          </div>
          <div className="text-left">
            <div className="font-semibold text-white group-hover:text-green-400">Regular WhatsApp</div>
            <div className="text-sm text-slate-400">com.whatsapp</div>
          </div>
        </button>

        <button
          onClick={() => select('com.whatsapp.w4b')}
          className="w-full flex items-center gap-4 bg-slate-800 hover:bg-slate-700 border border-slate-700 hover:border-green-500 rounded-xl p-5 transition-all group"
        >
          <div className="w-12 h-12 bg-teal-600 rounded-xl flex items-center justify-center">
            <Briefcase className="w-7 h-7 text-white" />
          </div>
          <div className="text-left">
            <div className="font-semibold text-white group-hover:text-green-400">WhatsApp Business</div>
            <div className="text-sm text-slate-400">com.whatsapp.w4b</div>
          </div>
        </button>
      </div>
    </div>
  );
}
