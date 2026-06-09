import { Routes, Route } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Topbar } from "./components/ui.jsx";
import Home from "./pages/Home.jsx";
import Access from "./pages/Access.jsx";
import Lease from "./pages/Lease.jsx";
import Share from "./pages/Share.jsx";
import Login from "./pages/Login.jsx";
import NotFound from "./pages/NotFound.jsx";

export default function App() {
  const { t } = useTranslation();
  return (
    <div className="shell">
      <Topbar />
      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<Login />} />
          <Route path="/access/:token" element={<Access />} />
          <Route path="/leases/:leaseId" element={<Lease />} />
          <Route path="/share/:viewerToken" element={<Share />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <footer className="page-foot">{t("footer")}</footer>
    </div>
  );
}
