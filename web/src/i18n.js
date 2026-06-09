import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import en from "./locales/en.json";
import zh from "./locales/zh.json";

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      zh: { translation: zh },
    },
    supportedLngs: ["en", "zh"],
    nonExplicitSupportedLngs: true,
    fallbackLng: "en",
    load: "languageOnly",
    interpolation: { escapeValue: false },
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
      lookupLocalStorage: "broker-lang",
    },
  });

// Keep <html lang> in sync so CJK-specific CSS (letter-spacing etc.) applies.
const syncLang = (lng) => {
  document.documentElement.lang = lng.startsWith("zh") ? "zh" : "en";
};
syncLang(i18n.resolvedLanguage || "en");
i18n.on("languageChanged", syncLang);

export default i18n;
