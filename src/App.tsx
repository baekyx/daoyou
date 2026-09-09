import React from 'react';
import { Toaster } from 'sonner';
import { AuthProvider } from '@/contexts/AuthContext';
import { AppLanguageProvider } from '@/i18n/AppLanguageContext';
import PrototypePage from '@/pages/Prototype';

// AuthProvider 下移至 App 层，确保 HMR 热重载时 PrototypePage 始终在 context 内渲染
const App: React.FC = () => {
  return (
    <AuthProvider>
      <AppLanguageProvider>
        <PrototypePage />
        <Toaster position="top-center" richColors />
      </AppLanguageProvider>
    </AuthProvider>
  );
};

export default App;
