module.exports = function(RED) {
    "use strict";
    
    function HCSR04Node(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        
        // Configuration
        node.triggerPin = parseInt(config.trigger) || 18;
        node.echoPin = parseInt(config.echo) || 24;
        node.interval = parseInt(config.interval) || 1000;
        
        // GPIO variables using fs-based approach (more reliable)
        var fs = require('fs');
        var measurementTimer;
        var isReading = false;
        var startTime;
        var echoWatcher;
        var triggerPath = '/sys/class/gpio/gpio' + node.triggerPin;
        var echoPath = '/sys/class/gpio/gpio' + node.echoPin;
        var isInitialized = false;
        
        // Helper function to write to GPIO
        function writeGpio(pin, value) {
            try {
                fs.writeFileSync('/sys/class/gpio/gpio' + pin + '/value', value ? '1' : '0');
                return true;
            } catch (err) {
                node.error("GPIO write error on pin " + pin + ": " + err.message);
                return false;
            }
        }
        
        // Helper function to export GPIO pin
        function exportPin(pin) {
            try {
                if (!fs.existsSync('/sys/class/gpio/gpio' + pin)) {
                    fs.writeFileSync('/sys/class/gpio/export', pin.toString());
                    // Wait a bit for the pin to be available
                    var timeout = Date.now() + 1000;
                    while (!fs.existsSync('/sys/class/gpio/gpio' + pin) && Date.now() < timeout) {
                        // Wait
                    }
                }
                return fs.existsSync('/sys/class/gpio/gpio' + pin);
            } catch (err) {
                node.error("Failed to export pin " + pin + ": " + err.message);
                return false;
            }
        }
        
        // Helper function to set pin direction
        function setPinDirection(pin, direction) {
            try {
                fs.writeFileSync('/sys/class/gpio/gpio' + pin + '/direction', direction);
                return true;
            } catch (err) {
                node.error("Failed to set direction for pin " + pin + ": " + err.message);
                return false;
            }
        }
        
        // Initialize GPIO pins
        function initializeGpio() {
            try {
                // Export and configure trigger pin
                if (!exportPin(node.triggerPin)) {
                    node.status({fill: "red", shape: "ring", text: "failed to export trigger pin"});
                    return false;
                }
                
                if (!setPinDirection(node.triggerPin, 'out')) {
                    node.status({fill: "red", shape: "ring", text: "failed to set trigger direction"});
                    return false;
                }
                
                // Set trigger to low initially
                if (!writeGpio(node.triggerPin, false)) {
                    node.status({fill: "red", shape: "ring", text: "failed to initialize trigger"});
                    return false;
                }
                
                // Export and configure echo pin
                if (!exportPin(node.echoPin)) {
                    node.status({fill: "red", shape: "ring", text: "failed to export echo pin"});
                    return false;
                }
                
                if (!setPinDirection(node.echoPin, 'in')) {
                    node.status({fill: "red", shape: "ring", text: "failed to set echo direction"});
                    return false;
                }
                
                // Set up echo pin monitoring
                try {
                    fs.writeFileSync('/sys/class/gpio/gpio' + node.echoPin + '/edge', 'both');
                } catch (err) {
                    node.error("Failed to set echo edge detection: " + err.message);
                    return false;
                }
                
                // Monitor echo pin using fs.watchFile (more reliable than fs.watch)
                var echoValuePath = '/sys/class/gpio/gpio' + node.echoPin + '/value';
                var lastValue = null;
                
                echoWatcher = setInterval(function() {
                    if (!isReading) return;
                    
                    try {
                        var currentValue = fs.readFileSync(echoValuePath, 'utf8').trim();
                        
                        if (lastValue !== null && currentValue !== lastValue) {
                            if (currentValue === '1' && lastValue === '0') {
                                // Rising edge - start timing
                                startTime = process.hrtime.bigint();
                            } else if (currentValue === '0' && lastValue === '1') {
                                // Falling edge - calculate distance
                                if (startTime) {
                                    var endTime = process.hrtime.bigint();
                                    var duration = Number(endTime - startTime) / 1000; // Convert to microseconds
                                    
                                    // Convert to distance in centimeters
                                    var distance = duration / 2 / 29.1;
                                    
                                    isReading = false;
                                    
                                    // Only send valid readings
                                    if (distance >= 2 && distance <= 400) {
                                        node.send({
                                            payload: parseFloat(distance.toFixed(2)),
                                            topic: "distance",
                                            unit: "cm",
                                            timestamp: Date.now()
                                        });
                                        
                                        node.status({
                                            fill: "green", 
                                            shape: "dot", 
                                            text: distance.toFixed(2) + " cm"
                                        });
                                    } else {
                                        node.status({
                                            fill: "yellow", 
                                            shape: "ring", 
                                            text: "out of range"
                                        });
                                    }
                                }
                            }
                        }
                        lastValue = currentValue;
                    } catch (err) {
                        // Ignore read errors during cleanup
                        if (isInitialized) {
                            node.error("Echo pin read error: " + err.message);
                        }
                    }
                }, 1); // Check every 1ms
                
                isInitialized = true;
                node.status({fill: "green", shape: "dot", text: "ready"});
                return true;
                
            } catch (err) {
                node.error("GPIO initialization failed: " + err.message);
                node.status({fill: "red", shape: "ring", text: "init failed"});
                return false;
            }
        }
        
        // Function to trigger a distance measurement
        function triggerMeasurement() {
            if (isReading || !isInitialized) return;
            
            try {
                isReading = true;
                startTime = null;
                
                // Send 10µs pulse to trigger pin
                if (writeGpio(node.triggerPin, true)) {
                    setTimeout(function() {
                        writeGpio(node.triggerPin, false);
                    }, 0.01); // 10µs delay
                } else {
                    isReading = false;
                    return;
                }
                
                // Safety timeout
                setTimeout(function() {
                    if (isReading) {
                        isReading = false;
                        node.status({fill: "yellow", shape: "ring", text: "timeout"});
                    }
                }, 100);
                
            } catch (err) {
                isReading = false;
                node.error("Trigger measurement failed: " + err.message);
                node.status({fill: "red", shape: "ring", text: "trigger failed"});
            }
        }
        
        // Initialize GPIO after a short delay
        setTimeout(function() {
            if (initializeGpio()) {
                node.log("HC-SR04 node initialized successfully");
            }
        }, 100);
        
        // Start periodic measurements
        function startMeasurements() {
            // Take initial measurement
            triggerMeasurement();
            
            // Set up interval timer for continuous measurements
            measurementTimer = setInterval(function() {
                triggerMeasurement();
            }, node.interval);
        }
        
        // Handle input messages (manual trigger)
        node.on('input', function(msg) {
            if (msg.payload === 'trigger' || msg.payload === true) {
                triggerMeasurement();
            } else if (msg.payload === 'start') {
                if (measurementTimer) {
                    clearInterval(measurementTimer);
                }
                startMeasurements();
            } else if (msg.payload === 'stop') {
                if (measurementTimer) {
                    clearInterval(measurementTimer);
                    measurementTimer = null;
                }
                node.status({fill: "grey", shape: "ring", text: "stopped"});
            }
        });
        
        // Start measurements when node is ready
        setTimeout(startMeasurements, 100);
        
        // Clean up on node close
        node.on('close', function() {
            isInitialized = false;
            isReading = false;
            
            // Clear measurement timer
            if (measurementTimer) {
                clearInterval(measurementTimer);
                measurementTimer = null;
            }
            
            // Clear echo watcher
            if (echoWatcher) {
                clearInterval(echoWatcher);
                echoWatcher = null;
            }
            
            // Clean up GPIO resources
            try {
                // Set trigger to LOW
                writeGpio(node.triggerPin, false);
                
                // Unexport pins
                if (fs.existsSync('/sys/class/gpio/gpio' + node.triggerPin)) {
                    fs.writeFileSync('/sys/class/gpio/unexport', node.triggerPin.toString());
                }
                if (fs.existsSync('/sys/class/gpio/gpio' + node.echoPin)) {
                    fs.writeFileSync('/sys/class/gpio/unexport', node.echoPin.toString());
                }
            } catch (err) {
                // Ignore cleanup errors
            }
            
            node.status({fill: "red", shape: "ring", text: "disconnected"});
        });
    }
    
    // Register the node
    RED.nodes.registerType("hcsr04", HCSR04Node);
};
