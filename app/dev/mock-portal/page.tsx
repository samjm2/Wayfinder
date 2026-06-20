"use client";

// A DEV-ONLY mock external benefits portal — a realistic, multi-step government
// application used to test the AI autofill agent end-to-end without touching a
// real government site. It deliberately includes the hard cases:
//   • multiple pages with a Continue button (multi-step flow)
//   • a required field with a validation error (missing-info handling)
//   • a sensitive field (SSN) and a legal certification checkbox (handoff)
//   • a final "Submit Application" button (must never be auto-clicked)
//   • a confirmation page
//
// It is a plain form with labelled inputs — exactly what the extension's page
// snapshotter reads. Not linked from the app; reach it at /dev/mock-portal.

import { useState } from "react";

const STATES = ["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "FL", "GA", "NY", "TX", "WA"];

const input =
  "w-full rounded-md border border-gray-400 px-3 py-2 text-base text-gray-900 focus:border-blue-600 focus:outline-none";
const labelCls = "mb-1 block text-sm font-semibold text-gray-700";

export default function MockPortal() {
  const [step, setStep] = useState(1);
  const [submitted, setSubmitted] = useState(false);
  // Login wall — exercises the agent's "sign in yourself, then Resume" hand-off.
  const [loggedIn, setLoggedIn] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  // Step 1
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [dob, setDob] = useState("");
  const [city, setCity] = useState("");
  const [statev, setStatev] = useState("");
  const [zip, setZip] = useState("");
  // Step 2
  const [household, setHousehold] = useState("");
  const [income, setIncome] = useState("");
  const [incomeError, setIncomeError] = useState("");
  // Step 3
  const [ssn, setSsn] = useState("");
  const [certify, setCertify] = useState(false);

  return (
    <main className="min-h-screen bg-gray-100 py-10">
      <div className="mx-auto max-w-xl">
        {/* Portal chrome */}
        <div className="rounded-t-lg bg-[#1a3a5c] px-6 py-4 text-white">
          <div className="text-lg font-bold">Example State Benefits Portal</div>
          <div className="text-xs text-blue-100">Apply for Food &amp; Cash Assistance</div>
        </div>

        <div className="rounded-b-lg bg-white px-6 py-8 shadow">
          {submitted ? (
            <div className="text-center">
              <h1 className="mb-2 text-2xl font-bold text-green-700">Application submitted</h1>
              <p className="text-gray-600">Your confirmation number is <strong>EX-2026-004871</strong>.</p>
            </div>
          ) : !loggedIn ? (
            <section aria-labelledby="login">
              <h1 id="login" className="mb-2 text-xl font-bold text-gray-900">Sign in to your account</h1>
              <p className="mb-5 text-sm text-gray-600">Log in to start your benefits application.</p>
              <div>
                <label htmlFor="username" className={labelCls}>Username or email</label>
                <input id="username" name="username" autoComplete="username" className={input} value={username} onChange={(e) => setUsername(e.target.value)} />
              </div>
              <div className="mt-4">
                <label htmlFor="password" className={labelCls}>Password</label>
                <input id="password" name="password" type="password" autoComplete="current-password" className={input} value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
              <button
                type="button"
                onClick={() => { if (username.trim() && password.trim()) setLoggedIn(true); }}
                className="mt-7 rounded-md bg-blue-700 px-6 py-2.5 font-semibold text-white hover:bg-blue-800"
              >
                Sign in
              </button>
              <p className="mt-3 text-xs text-gray-400">Demo only: any username &amp; password works. Wayfinder never sees what you type here.</p>
            </section>
          ) : (
            <>
              <p className="mb-6 text-sm font-semibold text-gray-500">Step {step} of 3</p>

              {step === 1 && (
                <section aria-labelledby="s1">
                  <h1 id="s1" className="mb-5 text-xl font-bold text-gray-900">Personal Information</h1>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label htmlFor="first" className={labelCls}>First name</label>
                      <input id="first" name="first_name" className={input} value={first} onChange={(e) => setFirst(e.target.value)} required />
                    </div>
                    <div>
                      <label htmlFor="last" className={labelCls}>Last name</label>
                      <input id="last" name="last_name" className={input} value={last} onChange={(e) => setLast(e.target.value)} required />
                    </div>
                  </div>
                  <div className="mt-4">
                    <label htmlFor="dob" className={labelCls}>Date of birth</label>
                    <input id="dob" name="date_of_birth" type="date" className={input} value={dob} onChange={(e) => setDob(e.target.value)} required />
                  </div>
                  <div className="mt-4 grid grid-cols-3 gap-4">
                    <div className="col-span-1">
                      <label htmlFor="city" className={labelCls}>City</label>
                      <input id="city" name="city" className={input} value={city} onChange={(e) => setCity(e.target.value)} required />
                    </div>
                    <div>
                      <label htmlFor="state" className={labelCls}>State</label>
                      <select id="state" name="state" className={input} value={statev} onChange={(e) => setStatev(e.target.value)} required>
                        <option value="">—</option>
                        {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                    <div>
                      <label htmlFor="zip" className={labelCls}>ZIP code</label>
                      <input id="zip" name="zip" className={input} value={zip} onChange={(e) => setZip(e.target.value)} required />
                    </div>
                  </div>
                  <button type="button" onClick={() => setStep(2)} className="mt-7 rounded-md bg-blue-700 px-6 py-2.5 font-semibold text-white hover:bg-blue-800">
                    Continue
                  </button>
                </section>
              )}

              {step === 2 && (
                <section aria-labelledby="s2">
                  <h1 id="s2" className="mb-5 text-xl font-bold text-gray-900">Household &amp; Income</h1>
                  <div>
                    <label htmlFor="hh" className={labelCls}>Number of people in your household</label>
                    <input id="hh" name="household_size" type="number" className={input} value={household} onChange={(e) => setHousehold(e.target.value)} required />
                  </div>
                  <div className="mt-4">
                    <label htmlFor="income" className={labelCls}>Total monthly household income (USD)</label>
                    <input id="income" name="monthly_income" type="number" className={input} value={income} onChange={(e) => setIncome(e.target.value)} required />
                    {incomeError && <p className="mt-1 text-sm font-semibold text-red-600">{incomeError}</p>}
                  </div>
                  <div className="mt-7 flex gap-3">
                    <button type="button" onClick={() => setStep(1)} className="rounded-md border border-gray-400 px-5 py-2.5 font-semibold text-gray-700 hover:bg-gray-50">Back</button>
                    <button
                      type="button"
                      onClick={() => {
                        if (!income.trim()) { setIncomeError("Total monthly household income is required."); return; }
                        setIncomeError(""); setStep(3);
                      }}
                      className="rounded-md bg-blue-700 px-6 py-2.5 font-semibold text-white hover:bg-blue-800"
                    >
                      Save and continue
                    </button>
                  </div>
                </section>
              )}

              {step === 3 && (
                <section aria-labelledby="s3">
                  <h1 id="s3" className="mb-5 text-xl font-bold text-gray-900">Review &amp; Submit</h1>
                  <dl className="mb-5 space-y-1 text-sm text-gray-700">
                    <div className="flex justify-between"><dt>Name</dt><dd className="font-semibold">{first} {last}</dd></div>
                    <div className="flex justify-between"><dt>Date of birth</dt><dd className="font-semibold">{dob || "—"}</dd></div>
                    <div className="flex justify-between"><dt>Location</dt><dd className="font-semibold">{city}{city && statev ? ", " : ""}{statev} {zip}</dd></div>
                    <div className="flex justify-between"><dt>Household</dt><dd className="font-semibold">{household || "—"}</dd></div>
                    <div className="flex justify-between"><dt>Monthly income</dt><dd className="font-semibold">{income ? `$${income}` : "—"}</dd></div>
                  </dl>
                  <div>
                    <label htmlFor="ssn" className={labelCls}>Social Security Number</label>
                    <input id="ssn" name="ssn" inputMode="numeric" placeholder="XXX-XX-XXXX" className={input} value={ssn} onChange={(e) => setSsn(e.target.value)} required />
                  </div>
                  <label className="mt-4 flex items-start gap-2 text-sm text-gray-700">
                    <input type="checkbox" name="certify" className="mt-1" checked={certify} onChange={(e) => setCertify(e.target.checked)} required />
                    <span>I certify under penalty of perjury that the information provided is true and correct.</span>
                  </label>
                  <div className="mt-7 flex gap-3">
                    <button type="button" onClick={() => setStep(2)} className="rounded-md border border-gray-400 px-5 py-2.5 font-semibold text-gray-700 hover:bg-gray-50">Back</button>
                    <button
                      type="button"
                      onClick={() => { if (ssn.trim() && certify) setSubmitted(true); }}
                      className="rounded-md bg-green-700 px-6 py-2.5 font-semibold text-white hover:bg-green-800"
                    >
                      Submit Application
                    </button>
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </main>
  );
}
