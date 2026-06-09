import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Panel } from "../components/ui.jsx";

export default function NotFound() {
  const { t } = useTranslation();
  return (
    <Panel kicker={t("notFound.kicker")} title={t("notFound.title")} sub={t("notFound.sub")}>
      <div className="actions">
        <Link className="button" to="/">{t("notFound.back")}</Link>
      </div>
    </Panel>
  );
}
