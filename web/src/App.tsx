import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ToastProvider } from './components/ui';
import { Landing } from './Landing';
import { StudentApp } from './pages/student/Student';
import { ConsoleApp } from './pages/console/Console';
import { InternalVerify } from './pages/console/InternalVerify';

export function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/app/*" element={<StudentApp />} />
          <Route path="/console/*" element={<ConsoleApp />} />
          <Route path="/internal/verify" element={<InternalVerify />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </ToastProvider>
    </BrowserRouter>
  );
}
