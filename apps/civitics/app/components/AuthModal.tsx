"use client";

import { useEffect, useRef } from "react";
import { SignInForm } from "./SignInForm";

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** What triggered the modal — shown as context above the form */
  trigger?: string;
}

export function AuthModal({ isOpen, onClose, trigger }: AuthModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  // Prevent body scroll when modal is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const next =
    typeof window !== "undefined" ? window.location.pathname : "/";

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div className="relative w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-6 shadow-xl">
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute right-4 top-4 flex h-7 w-7 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
          aria-label="Close"
        >
          ✕
        </button>

        {/* Logo */}
        <div className="mb-5 flex flex-col items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-600">
            <span className="text-xs font-bold text-white">CV</span>
          </div>
        </div>

        {/* Heading — generic or contextual */}
        <div className="mb-5 text-center">
          {trigger ? (
            <>
              <h2 className="text-base font-semibold text-gray-900">
                {trigger}
              </h2>
              <p className="mt-1 text-xs text-gray-500">
                Sign in to continue
              </p>
            </>
          ) : (
            <>
              <h2 className="text-base font-semibold text-gray-900">
                Sign in to Civitics
              </h2>
              <p className="mt-1 text-xs text-gray-500">
                Track civic engagement, save positions, and follow officials.
              </p>
            </>
          )}
        </div>

        {/* Form */}
        <SignInForm next={next} onSent={() => {}} />
      </div>
    </div>
  );
}
