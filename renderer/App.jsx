import React, { useState } from 'react';
import { MessageCircle, CheckCircle, Circle, ChevronRight } from 'lucide-react';
import Step1_Welcome from './steps/Step1_Welcome';
import Step2_SelectApp from './steps/Step2_SelectApp';
import Step3_ConnectAndroid from './steps/Step3_ConnectAndroid';
import Step4_ExtractAndroid from './steps/Step4_ExtractAndroid';
import Step5_ConnectIPhone from './steps/Step5_ConnectIPhone';
import Step6_BackupIPhone from './steps/Step6_BackupIPhone';
import Step7_Transfer from './steps/Step7_Transfer';
import Step8_Done from './steps/Step8_Done';

const STEPS = [
  { id: 1, label: 'Welcome' },
  { id: 2, label: 'Select App' },
  { id: 3, label: 'Android' },
  { id: 4, label: 'Extract' },
  { id: 5, label: 'iPhone' },
  { id: 6, label: 'Backup' },
  { id: 7, label: 'Transfer' },
  { id: 8, label: 'Done' },
];

export default function App() {
  const [currentStep, setCurrentStep] = useState(1);
  const [transferData, setTransferData] = useState({
    appId: null,          // 'com.whatsapp' | 'com.whatsapp.w4b'
    deviceId: null,
    backupPath: null,
    androidDbPath: null,
    iosBackupId: null,
    stats: null,
  });

  const next = (data = {}) => {
    setTransferData(prev => ({ ...prev, ...data }));
    setCurrentStep(s => Math.min(s + 1, 8));
  };

  const restart = () => {
    setCurrentStep(1);
    setTransferData({ appId: null, deviceId: null, backupPath: null, androidDbPath: null, iosBackupId: null, stats: null });
  };

  const stepProps = { transferData, next, restart };

  const stepComponents = {
    1: <Step1_Welcome {...stepProps} />,
    2: <Step2_SelectApp {...stepProps} />,
    3: <Step3_ConnectAndroid {...stepProps} />,
    4: <Step4_ExtractAndroid {...stepProps} />,
    5: <Step5_ConnectIPhone {...stepProps} />,
    6: <Step6_BackupIPhone {...stepProps} />,
    7: <Step7_Transfer {...stepProps} />,
    8: <Step8_Done {...stepProps} />,
  };

  return (
    <div className="flex h-screen bg-slate-900">
      {/* Sidebar */}
      <div className="w-56 bg-slate-800 border-r border-slate-700 flex flex-col">
        <div className="p-4 border-b border-slate-700 flex items-center gap-2">
          <MessageCircle className="text-green-400 w-6 h-6" />
          <span className="font-bold text-white text-sm">WA Transfer</span>
        </div>
        <nav className="flex-1 p-3">
          {STEPS.map((step, idx) => {
            const done = currentStep > step.id;
            const active = currentStep === step.id;
            return (
              <div key={step.id} className="flex items-center gap-2 py-2">
                {done ? (
                  <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />
                ) : active ? (
                  <div className="w-4 h-4 rounded-full border-2 border-green-400 flex-shrink-0" />
                ) : (
                  <Circle className="w-4 h-4 text-slate-600 flex-shrink-0" />
                )}
                <span className={`text-xs ${active ? 'text-green-400 font-semibold' : done ? 'text-slate-300' : 'text-slate-500'}`}>
                  {step.label}
                </span>
              </div>
            );
          })}
        </nav>
        <div className="p-3 border-t border-slate-700">
          <p className="text-xs text-slate-500">v1.0.0 — Open Source</p>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-y-auto">
        {stepComponents[currentStep]}
      </div>
    </div>
  );
}
