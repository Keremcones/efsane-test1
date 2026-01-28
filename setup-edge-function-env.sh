#!/bin/bash

# Setup environment variables for Edge Functions
# This script sets the required secrets for check-alarm-signals function

set -e

PROJECT_ID="jcrbhekrphxodxhkuzju"

# Load from .env
source .env

echo "📋 Setting up Edge Function environment variables..."
echo "Project ID: $PROJECT_ID"

# Note: Supabase CLI v1.x doesn't have direct env var command for edge functions
# We need to use the REST API or Dashboard
# For now, provide instructions:

echo ""
echo "🔴 MANUAL SETUP REQUIRED 🔴"
echo ""
echo "Go to: https://supabase.com/dashboard/project/$PROJECT_ID/settings/functions"
echo ""
echo "Add these Environment Variables:"
echo "================================"
echo ""
echo "1. SUPABASE_URL"
echo "   Value: $SUPABASE_URL"
echo ""
echo "2. SUPABASE_SERVICE_ROLE_KEY"
echo "   Value: $SUPABASE_SERVICE_ROLE_KEY"
echo ""
echo "3. TELEGRAM_BOT_TOKEN"
echo "   Value: $TELEGRAM_BOT_TOKEN"
echo ""
echo "================================"
echo ""
echo "Then click 'Deploy all' in the Edge Functions section"
echo ""
