#!/usr/bin/env python3
"""
Setup Edge Function Environment Variables via Supabase Management API
This requires SUPABASE_ACCESS_TOKEN environment variable
"""

import os
import json
import sys
from urllib.request import Request, urlopen
from urllib.error import URLError

def setup_edge_function_env():
    # Load environment variables
    try:
        from dotenv import load_dotenv
        load_dotenv()
    except ImportError:
        print("Note: python-dotenv not installed, using system env vars")
    
    supabase_url = os.getenv("SUPABASE_URL")
    supabase_service_role = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    telegram_token = os.getenv("TELEGRAM_BOT_TOKEN")
    access_token = os.getenv("SUPABASE_ACCESS_TOKEN")
    project_id = "jcrbhekrphxodxhkuzju"
    
    print("🔧 Edge Function Environment Variables Setup")
    print("=" * 50)
    print()
    
    if not access_token:
        print("⚠️  SUPABASE_ACCESS_TOKEN not set in environment")
        print()
        print("To get your access token:")
        print("1. Visit: https://supabase.com/dashboard/account/tokens")
        print("2. Create new token with 'functions' scope")
        print("3. Run: export SUPABASE_ACCESS_TOKEN='your_token'")
        print()
        print("Then run this script again.")
        print()
        return False
    
    print("Checking configuration...")
    
    if not supabase_url:
        print("❌ SUPABASE_URL not found in .env")
        return False
    print(f"✅ SUPABASE_URL: {supabase_url}")
    
    if not supabase_service_role:
        print("❌ SUPABASE_SERVICE_ROLE_KEY not found in .env")
        return False
    print("✅ SUPABASE_SERVICE_ROLE_KEY: [hidden]")
    
    if not telegram_token:
        print("❌ TELEGRAM_BOT_TOKEN not found in .env")
        return False
    print("✅ TELEGRAM_BOT_TOKEN: [hidden]")
    
    print()
    print("📝 For manual setup without API token:")
    print()
    print("Go to: https://supabase.com/dashboard/project/" + project_id + "/settings/functions")
    print()
    print("Add these secrets:")
    print()
    print("1. Name: SUPABASE_URL")
    print(f"   Value: {supabase_url}")
    print()
    print("2. Name: SUPABASE_SERVICE_ROLE_KEY")
    print(f"   Value: {supabase_service_role}")
    print()
    print("3. Name: TELEGRAM_BOT_TOKEN")
    print(f"   Value: {telegram_token}")
    print()
    print("Then click 'Deploy' button")
    print()
    print("Note: Automated API setup requires SUPABASE_ACCESS_TOKEN (not implemented yet)")
    print()
    
    return True

if __name__ == "__main__":
    success = setup_edge_function_env()
    sys.exit(0 if success else 1)
