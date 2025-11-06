module.exports = function(RED) {
    "use strict";
    
    function HCSR04Node(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        
        // Configuration
        node.triggerPin = parseInt(config.trigger) || 18;
        node.echoPin = parseInt(config.echo) || 24;
        node.interval = parseInt(config.interval) || 1000;
        
        // GPIO variables
        var gpio;
        var measurementTimer;
        var isReading = false;
        var startTime;
        
        // Initialize GPIO
        try {
            gpio = require('rpi-gpio');
        } catch (err) {
            node.error("Failed to load rpi-gpio library: " + err.message);
            node.status({fill: "red", shape: "ring", text: "rpi-gpio not available"});
            return;
        }
        
        // Initialize GPIO pins
        gpio.setMode(gpio.MODE_BCM);
        
        // Setup trigger pin as output
        gpio.setup(node.triggerPin, gpio.DIR_OUT, function(err) {
            if (err) {
                node.error("Failed to setup trigger pin: " + err.message);
                node.status({fill: "red", shape: "ring", text: "trigger pin setup failed"});
                return;
            }
            
            // Setup echo pin as input
            gpio.setup(node.echoPin, gpio.DIR_IN, gpio.EDGE_BOTH, function(err) {
                if (err) {
                    node.error("Failed to setup echo pin: " + err.message);
                    node.status({fill: "red", shape: "ring", text: "echo pin setup failed"});
                    return;
                }
                
                // Listen for changes on echo pin
                gpio.on('change', function(channel, value) {
                    if (channel === node.echoPin && isReading) {
                        if (value) {
                            // Rising edge - start timing
                            startTime = process.hrtime.bigint();
                        } else {
                            // Falling edge - calculate distance
                            if (startTime) {
                                var endTime = process.hrtime.bigint();
                                var duration = Number(endTime - startTime) / 1000; // Convert to microseconds
                                
                                // Convert to distance in centimeters
                                // Speed of sound = 343 m/s = 34300 cm/s = 0.0343 cm/µs
                                // Distance = (time * speed) / 2 (divided by 2 for round trip)
                                var distance = duration / 2 / 29.1;
                                
                                isReading = false;
                                
                                // Only send valid readings (typically 2cm to 400cm for HC-SR04)
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
                                    // Out of range reading
                                    node.status({
                                        fill: "yellow", 
                                        shape: "ring", 
                                        text: "out of range"
                                    });
                                }
                            }
                        }
                    }
                });
                
                node.status({fill: "green", shape: "dot", text: "ready"});
            });
        });
        
        // Function to trigger a distance measurement
        function triggerMeasurement() {
            if (isReading) return; // Prevent overlapping readings
            
            try {
                isReading = true;
                startTime = null;
                
                // Send 10µs pulse to trigger pin
                gpio.write(node.triggerPin, true, function(err) {
                    if (err) {
                        node.error("Failed to write HIGH to trigger: " + err.message);
                        isReading = false;
                        return;
                    }
                    
                    setTimeout(function() {
                        gpio.write(node.triggerPin, false, function(err) {
                            if (err) {
                                node.error("Failed to write LOW to trigger: " + err.message);
                                isReading = false;
                            }
                        });
                    }, 0.01); // 10µs delay
                });
                
                // Safety timeout to reset reading state
                setTimeout(function() {
                    if (isReading) {
                        isReading = false;
                        node.status({fill: "yellow", shape: "ring", text: "timeout"});
                    }
                }, 100); // 100ms timeout
                
            } catch (err) {
                isReading = false;
                node.error("Failed to trigger measurement: " + err.message);
                node.status({fill: "red", shape: "ring", text: "trigger failed"});
            }
        }
        
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
            // Clear measurement timer
            if (measurementTimer) {
                clearInterval(measurementTimer);
                measurementTimer = null;
            }
            
            // Clean up GPIO resources
            try {
                gpio.write(node.triggerPin, false); // Set trigger to LOW
                gpio.destroy(); // Clean up all GPIO
            } catch (err) {
                node.error("Error during cleanup: " + err.message);
            }
            
            node.status({fill: "red", shape: "ring", text: "disconnected"});
        });
    }
    
    // Register the node
    RED.nodes.registerType("hcsr04", HCSR04Node);
};
