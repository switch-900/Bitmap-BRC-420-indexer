#!/bin/bash

# BRC-420 Indexer Production Startup Script
# This script provides safe startup with logging and error handling

set -euo pipefail  # Exit on error, undefined vars, pipe failures

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="${SCRIPT_DIR}/logs"
PID_FILE="${SCRIPT_DIR}/server.pid"
MAX_STARTUP_TIME=60  # seconds
DEFAULT_PORT=8080

# Create logs directory
mkdir -p "${LOG_DIR}"

# Logging functions
log() {
    echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')] $1${NC}" | tee -a "${LOG_DIR}/startup.log"
}

warn() {
    echo -e "${YELLOW}[$(date +'%Y-%m-%d %H:%M:%S')] WARNING: $1${NC}" | tee -a "${LOG_DIR}/startup.log"
}

error() {
    echo -e "${RED}[$(date +'%Y-%m-%d %H:%M:%S')] ERROR: $1${NC}" | tee -a "${LOG_DIR}/startup.log"
}

info() {
    echo -e "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')] INFO: $1${NC}" | tee -a "${LOG_DIR}/startup.log"
}

# Cleanup function
cleanup() {
    if [[ -f "${PID_FILE}" ]]; then
        local pid=$(cat "${PID_FILE}")
        if kill -0 "$pid" 2>/dev/null; then
            log "Stopping server (PID: $pid)..."
            kill -TERM "$pid" 2>/dev/null || true
            
            # Wait for graceful shutdown
            local count=0
            while kill -0 "$pid" 2>/dev/null && [[ $count -lt 10 ]]; do
                sleep 1
                ((count++))
            done
            
            # Force kill if still running
            if kill -0 "$pid" 2>/dev/null; then
                warn "Force killing server..."
                kill -KILL "$pid" 2>/dev/null || true
            fi
        fi
        rm -f "${PID_FILE}"
    fi
}

# Check if port is available
check_port() {
    local port=${1:-$DEFAULT_PORT}
    if command -v nc >/dev/null 2>&1; then
        if nc -z localhost "$port" 2>/dev/null; then
            return 1  # Port is in use
        fi
    elif command -v netstat >/dev/null 2>&1; then
        if netstat -tuln 2>/dev/null | grep -q ":$port "; then
            return 1  # Port is in use
        fi
    elif command -v ss >/dev/null 2>&1; then
        if ss -tuln 2>/dev/null | grep -q ":$port "; then
            return 1  # Port is in use
        fi
    else
        warn "Cannot check port availability (nc, netstat, and ss not found)"
        return 0  # Assume available
    fi
    return 0  # Port is available
}

# Wait for server to be ready
wait_for_server() {
    local port=${WEB_PORT:-$DEFAULT_PORT}
    local url="http://localhost:$port/health"
    local count=0
    
    log "Waiting for server to be ready on port $port..."
    
    while [[ $count -lt $MAX_STARTUP_TIME ]]; do
        if command -v curl >/dev/null 2>&1; then
            if curl -s -f "$url" >/dev/null 2>&1; then
                log "Server is ready!"
                return 0
            fi
        elif command -v wget >/dev/null 2>&1; then
            if wget -q -O /dev/null "$url" 2>/dev/null; then
                log "Server is ready!"
                return 0
            fi
        else
            # Fallback: just check if port is listening
            if ! check_port "$port"; then
                log "Server is listening on port $port"
                return 0
            fi
        fi
        
        sleep 1
        ((count++))
        
        if [[ $((count % 10)) -eq 0 ]]; then
            info "Still waiting... ($count/${MAX_STARTUP_TIME}s)"
        fi
    done
    
    error "Server failed to start within ${MAX_STARTUP_TIME} seconds"
    return 1
}

# Check system requirements
check_requirements() {
    log "Checking system requirements..."
    
    # Check Node.js
    if ! command -v node >/dev/null 2>&1; then
        error "Node.js is not installed"
        return 1
    fi
    
    local node_version=$(node --version | sed 's/v//')
    local major_version=$(echo "$node_version" | cut -d. -f1)
    
    if [[ $major_version -lt 18 ]]; then
        error "Node.js version 18+ required (found: $node_version)"
        return 1
    fi
    
    log "Node.js version: $node_version ✓"
    
    # Check npm packages
    if [[ ! -d "node_modules" ]]; then
        warn "node_modules not found, running npm install..."
        npm install || {
            error "Failed to install dependencies"
            return 1
        }
    fi
    
    # Check required files
    local required_files=("server.js" "config.js" "package.json")
    for file in "${required_files[@]}"; do
        if [[ ! -f "$file" ]]; then
            error "Required file not found: $file"
            return 1
        fi
    done
    
    log "System requirements check passed ✓"
    return 0
}

# Print configuration
print_config() {
    log "Configuration:"
    log "  Environment: ${NODE_ENV:-development}"
    log "  Web Port: ${WEB_PORT:-$DEFAULT_PORT}"
    log "  API Port: ${PORT:-5000}"
    log "  Run Indexer: ${RUN_INDEXER:-true}"
    log "  Database: ${DB_PATH:-./db/brc420.db}"
    log "  Log Directory: ${LOG_DIR}"
    log "  PID File: ${PID_FILE}"
}

# Start in test mode (simple server)
start_test() {
    log "Starting in TEST mode (simple server, no database)..."
    
    local port=${WEB_PORT:-$DEFAULT_PORT}
    if ! check_port "$port"; then
        error "Port $port is already in use"
        return 1
    fi
    
    # Start simple test server
    node server-simple.js > "${LOG_DIR}/test-server.log" 2>&1 &
    local pid=$!
    echo "$pid" > "${PID_FILE}"
    
    log "Test server started with PID: $pid"
    
    if wait_for_server; then
        log "✅ TEST SERVER READY"
        log "   URL: http://localhost:$port"
        log "   Health: http://localhost:$port/api/health"
        log "   Logs: ${LOG_DIR}/test-server.log"
        log "   PID: $pid"
        return 0
    else
        error "Test server failed to start"
        cleanup
        return 1
    fi
}

# Start in production mode
start_production() {
    log "Starting in PRODUCTION mode..."
    
    local port=${WEB_PORT:-$DEFAULT_PORT}
    if ! check_port "$port"; then
        error "Port $port is already in use"
        return 1
    fi
    
    # Set production environment
    export NODE_ENV=production
    export RUN_INDEXER=${RUN_INDEXER:-false}  # Default to false in production
    
    # Start production server
    node server.js > "${LOG_DIR}/production-server.log" 2>&1 &
    local pid=$!
    echo "$pid" > "${PID_FILE}"
    
    log "Production server started with PID: $pid"
    
    if wait_for_server; then
        log "✅ PRODUCTION SERVER READY"
        log "   URL: http://localhost:$port"
        log "   Health: http://localhost:$port/api/health"
        log "   Logs: ${LOG_DIR}/production-server.log"
        log "   PID: $pid"
        return 0
    else
        error "Production server failed to start"
        cleanup
        return 1
    fi
}

# Start in development mode
start_development() {
    log "Starting in DEVELOPMENT mode..."
    
    local port=${WEB_PORT:-$DEFAULT_PORT}
    if ! check_port "$port"; then
        error "Port $port is already in use"
        return 1
    fi
    
    # Set development environment
    export NODE_ENV=development
    export RUN_INDEXER=${RUN_INDEXER:-true}
    
    # Start development server with more verbose logging
    node server.js 2>&1 | tee "${LOG_DIR}/development-server.log" &
    local pid=$!
    echo "$pid" > "${PID_FILE}"
    
    log "Development server started with PID: $pid"
    
    if wait_for_server; then
        log "✅ DEVELOPMENT SERVER READY"
        log "   URL: http://localhost:$port"
        log "   Health: http://localhost:$port/api/health"
        log "   Logs: ${LOG_DIR}/development-server.log"
        log "   PID: $pid"
        return 0
    else
        error "Development server failed to start"
        cleanup
        return 1
    fi
}

# Show status
show_status() {
    if [[ -f "${PID_FILE}" ]]; then
        local pid=$(cat "${PID_FILE}")
        if kill -0 "$pid" 2>/dev/null; then
            log "Server is running (PID: $pid)"
            
            local port=${WEB_PORT:-$DEFAULT_PORT}
            if command -v curl >/dev/null 2>&1; then
                local health=$(curl -s "http://localhost:$port/api/health" 2>/dev/null || echo "unreachable")
                if [[ "$health" == "unreachable" ]]; then
                    warn "Server process exists but health check failed"
                else
                    log "Health check: OK"
                fi
            fi
            return 0
        else
            warn "PID file exists but process is not running"
            rm -f "${PID_FILE}"
            return 1
        fi
    else
        log "Server is not running"
        return 1
    fi
}

# Stop server
stop_server() {
    log "Stopping server..."
    cleanup
    log "Server stopped"
}

# Main function
main() {
    local command=${1:-""}
    
    # Set up signal handlers
    trap cleanup EXIT INT TERM
    
    case "$command" in
        "test")
            log "=== BRC-420 INDEXER TEST STARTUP ==="
            check_requirements || exit 1
            print_config
            start_test || exit 1
            ;;
        "production"|"prod")
            log "=== BRC-420 INDEXER PRODUCTION STARTUP ==="
            check_requirements || exit 1
            print_config
            start_production || exit 1
            ;;
        "development"|"dev"|"")
            log "=== BRC-420 INDEXER DEVELOPMENT STARTUP ==="
            check_requirements || exit 1
            print_config
            start_development || exit 1
            ;;
        "status")
            show_status
            ;;
        "stop")
            stop_server
            ;;
        "restart")
            stop_server
            sleep 2
            start_development || exit 1
            ;;
        "logs")
            if [[ -f "${LOG_DIR}/development-server.log" ]]; then
                tail -f "${LOG_DIR}/development-server.log"
            elif [[ -f "${LOG_DIR}/production-server.log" ]]; then
                tail -f "${LOG_DIR}/production-server.log"
            elif [[ -f "${LOG_DIR}/test-server.log" ]]; then
                tail -f "${LOG_DIR}/test-server.log"
            else
                error "No log files found"
                exit 1
            fi
            ;;
        "help"|"-h"|"--help")
            echo "BRC-420 Indexer Startup Script"
            echo ""
            echo "Usage: $0 [command]"
            echo ""
            echo "Commands:"
            echo "  test         Start test server (no database, no indexer)"
            echo "  development  Start development server (default)"
            echo "  production   Start production server"
            echo "  status       Show server status"
            echo "  stop         Stop server"
            echo "  restart      Restart server"
            echo "  logs         Show live logs"
            echo "  help         Show this help"
            echo ""
            echo "Environment Variables:"
            echo "  WEB_PORT     Web server port (default: 8080)"
            echo "  PORT         API server port (default: 5000)"
            echo "  NODE_ENV     Environment (development/production)"
            echo "  RUN_INDEXER  Run indexer process (true/false)"
            echo "  DB_PATH      Database file path"
            ;;
        *)
            error "Unknown command: $command"
            echo "Use '$0 help' for usage information"
            exit 1
            ;;
    esac
}

# Run main function with all arguments
main "$@"