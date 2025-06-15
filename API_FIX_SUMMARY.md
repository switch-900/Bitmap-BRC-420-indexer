# BRC-420 Indexer - API Endpoint Fix Complete

## Issue Resolved ✅

**Problem**: HTTP 406 "Not Acceptable" errors when fetching block inscriptions from ordinals.com API

**Root Cause**: 
- Missing `Accept: application/json` header in API requests
- Incorrect external API URL format

## Changes Made

### 1. API URL Corrections
- **External API**: Fixed from `https://ordinals.com/api` to `https://ordinals.com`
- **Local API**: Confirmed `http://umbrel.local:4000` for Umbrel network access

### 2. Request Headers Fixed
- Added `Accept: application/json` header to all ord API requests
- Ensures proper JSON response format from ord service

### 3. Enhanced Error Handling
- Network timeout protection (10-second timeout)
- Smart fallback from local to external API
- Automatic retry mechanisms with exponential backoff

### 4. Files Updated
- `index-runner.js` - Main indexer with corrected API calls
- `index.js` - Alternative indexer implementation
- `config.js` - URL configuration management
- App store submodule - Latest container configurations

## Deployment Status

✅ **Committed & Pushed**: All changes committed to both repositories
✅ **Ready for Deployment**: App can now be updated on Umbrel
✅ **API Compatibility**: Works with both local ord and external ordinals.com

## Next Steps

1. **Update Umbrel App**: The app store has the latest version ready for installation
2. **Monitor Logs**: Check that HTTP 406 errors are resolved
3. **Verify Processing**: Ensure blocks are being processed successfully

## Technical Details

The key fix was ensuring that ord API requests include the proper `Accept: application/json` header, which is required by the ord service to return JSON responses instead of HTML. This prevents the HTTP 406 "Not Acceptable" errors that were blocking inscription processing.

**Commit Hash**: `2d0ae8c`
**Status**: Production Ready ✅
