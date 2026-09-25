"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function setPassword(formData: FormData) {
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(
    formData.get("confirmPassword") ?? "",
  );

  if (password.length < 8) {
    redirect("/set-password?error=Password must be at least 8 characters.");
  }

  if (password !== confirmPassword) {
    redirect("/set-password?error=Passwords do not match.");
  }

  const supabase = await createClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    redirect("/login");
  }

  const { error } = await supabase.auth.updateUser({
    password,
  });

  if (error) {
    redirect(`/set-password?error=${encodeURIComponent(error.message)}`);
  }

  redirect("/");
}